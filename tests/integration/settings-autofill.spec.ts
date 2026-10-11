/**
 * Integration: the discovery seam over the REAL settings service.
 *
 * Boots a test-only profile through the Loader (`boot` from
 * `@deepseek-ai/dsh-app-boot`) composed of the real config editor, the real
 * `SettingsForms` service, a probe plugin carrying an `llm-pi-ai`-shaped
 * volatile Config, and this plugin. The setup mirrors production: the plugin
 * reaches discovery through the `llm` service seam, and its describing wrap is
 * driven exactly as the Models page drives it — by calling `discoverModels` and
 * adopting the answer.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Hmr from '@deepseek-ai/dsh-hmr'
import Settings from '@deepseek-ai/dsh-settings'
import LlmRuntime, { type LlmDiscoveredModel } from '@deepseek-ai/dsh-llm'
import { apply as applyAutofill, resolveConfig } from '../../src/index.ts'

const TARGET = 'llm-pi-ai'

/** Faithful replica of the llm-pi-ai model/profile schema fields the fills write. */
const modelFieldsShape = {
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  input: z.array(z.union(['text', 'image'] as const)),
}
const modelProfile = z.object({ id: z.string().required(), ...modelFieldsShape })
const modelOverride = z.object(modelFieldsShape)
const profile = z.object({
  apiKeyEnv: z.string(),
  api: z.string(),
  baseURL: z.string(),
  models: z.array(modelProfile),
  modelOverrides: z.dict(modelOverride),
})
/** `providers` is volatile exactly as llm-pi-ai declares it, so live edits apply without a remount. */
const targetSchema = z.object({ providers: z.dict(profile).default({}).volatile() })

/** The subset of plugin config these tests drive. */
const CONFIG = {
  enabled: true,
  refreshOnStart: false,
  sources: ['models.dev'],
  timeoutMs: 5000,
}

/**
 * The REAL LLM runtime, with `llm-pi-ai`'s discovery registered through the
 * documented API. A hand-built stand-in cannot cover this seam: the plugin
 * reaches the service through the Cordis context, and only the real runtime
 * proves the wrap is installed on the instance the `@Remote` adapter calls
 * `this.discoverModels` on. A stand-in that recorded calls on a plain object
 * passed while the live page received undescribed rows.
 */
class FakeLlm {
  /** Models the registered discovery discloses, in endpoint order. */
  candidates: readonly LlmDiscoveredModel[] = []
  failure: Error | undefined
  /** How many times the registered discovery has run. */
  asks = 0
  /** Set by the fixture once the runtime is mounted. */
  runtime: LlmRuntime | undefined

  /**
   * Register this stand-in's answer as the `llm-pi-ai` discovery.
   * @param ctx - the booted context carrying the real runtime.
   */
  install(ctx: Context): void {
    ctx.llm.registerModelDiscovery(TARGET, async () => {
      this.asks += 1
      if (this.failure !== undefined) throw this.failure
      return [...this.candidates]
    })
  }
}

interface Fixture {
  ctx: Context
  /** The stand-in whose discovery the real LLM runtime serves. */
  llm: FakeLlm
  /** The resolved `llm-pi-ai` section as the plugin sees it. */
  section: () => Record<string, unknown> | undefined
  /** Models of the fixture's `gateway` provider. */
  models: () => Array<Record<string, unknown>>
  /** Count of `settings/document-updated` events for the target entry. */
  events: () => number
  /**
   * Interrogate the endpoint the way the Models page does, returning what the
   * caller would adopt.
   * @param settingsNs - namespace to ask; the plugin describes only `llm-pi-ai`.
   * @returns the candidates an adopt action receives.
   */
  discover: (settingsNs?: string) => Promise<LlmDiscoveredModel[]>
  /** Call one plugin-owned HTTP route through its registered handler. */
  call: (path: string, body: unknown) => Promise<{ status: number; payload: Record<string, unknown> }>
  dispose: () => Promise<void>
}

/**
 * Minimal stand-in for the host web server: it records the routes a plugin
 * registers and lets a test drive one handler directly. Exercising the real
 * route is what proves the button's endpoint actually writes settings.
 */
class FakeWebServer {
  readonly routes = new Map<string, (req: unknown, res: unknown) => void | Promise<void>>()
  register(route: { path: string; handler: (req: unknown, res: unknown) => void | Promise<void> }): () => void {
    this.routes.set(route.path, route.handler)
    return () => { this.routes.delete(route.path) }
  }
}

const cleanup: Array<() => Promise<void> | void> = []
after(async () => {
  for (const fn of cleanup.reverse()) await fn()
})

/**
 * Boot one test profile.
 *
 * `providers` seeds the target entry's USER layer — the profile patch file,
 * which is what `configEditor` reports as `override` and what marks a route as
 * writable for this plugin. Seeding the bundle layer instead would put the
 * routes in the composition base, where the plugin deliberately never writes.
 */
async function fixture(options: {
  providers?: Record<string, unknown>
  config?: Partial<typeof CONFIG>
} = {}): Promise<Fixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dma-settings-')))
  const dir = join(home, 'profiles', 'test')
  cleanup.push(() => { rmSync(home, { recursive: true, force: true }) })
  initProfile(dir, ['test-bundle'])
  const bundle = join(dir, 'node_modules', 'test-bundle')
  mkdirSync(bundle, { recursive: true })
  writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'config-editor', name: 'cordis:editor' },
    { id: 'settings', name: 'cordis:settings' },
    { id: TARGET, name: 'cordis:target' },
    { id: 'model-meta-autofill', name: 'cordis:autofill', config: options.config ?? CONFIG },
  ] }]))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  // The USER layer: the profile patch file the settings service writes through.
  writeFileSync(join(dir, 'cordis.patch.yml'), JSON.stringify([
    { id: TARGET, name: 'cordis:target', config: { providers: options.providers ?? {} } },
  ]))

  const profileContext: ProfileContext = {
    name: 'test', startedBundles: ['test-bundle'], dir,
    patchPath: join(dir, 'cordis.patch.yml'), installAnchor: join(home, 'package.json'),
    cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
  }
  const Target = {
    Config: targetSchema,
    apply: () => {},
  }
  const Autofill = {
    name: 'dsh-model-meta-autofill',
    apply: applyAutofill,
  }
  const webServer = new FakeWebServer()
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profileContext), (c) => {
    c.provide('profileContext', profileContext)
    c.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    c.provide('webServer', webServer)
    Object.assign(c.loader.builtins, {
      editor: ConfigEditor, settings: Settings, target: Target, autofill: Autofill,
    })
  })
  cleanup.push(async () => { await ctx.fiber.dispose() })

  await ctx.plugin(Timer)
  // The REAL LLM runtime: the plugin walks the Cordis context to reach it, so
  // only the real service proves the wrap lands on the instance the Remote
  // adapter calls into.
  await ctx.plugin(LlmRuntime)
  const llm = new FakeLlm()
  llm.install(ctx)

  const hmr = ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
  await hmr.await()
  await ctx.hmr.runExclusive(async () => {})

  let events = 0
  ctx.on('settings/document-updated', (ns) => { if (String(ns) === TARGET) events += 1 })

  const descriptor = () => ctx.settings.describe().find((row) => String(row.ns) === TARGET)
  const section = () => {
    const value = descriptor()?.value
    return value === null || typeof value !== 'object' ? undefined : value as Record<string, unknown>
  }
  const models = (): Array<Record<string, unknown>> => {
    const providers = section()?.['providers'] as Record<string, { models?: Array<Record<string, unknown>> }> | undefined
    return providers?.['gateway']?.models ?? []
  }
  return {
    ctx,
    llm,
    section,
    models,
    events: () => events,
    // Through the REAL runtime, exactly as the Models page reaches it — and, on
    // the path the page actually uses, through the Remote adapter.
    discover: (settingsNs = TARGET) => ctx.llm.discoverModels(settingsNs, { baseURL: 'https://gw.example/v1' }),
    call: (path, body) => callRoute(webServer, path, body),
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

/**
 * Drive one registered plugin route with a synthetic request/response pair.
 * A path may carry a query string: routes are keyed by pathname alone, and the
 * full URL is what the handler reads from `req.url`.
 */
function callRoute(
  webServer: FakeWebServer,
  path: string,
  body: unknown,
): Promise<{ status: number; payload: Record<string, unknown> }> {
  const handler = webServer.routes.get(path.split('?')[0]!)
  if (handler === undefined) throw new Error(`route not registered: ${path}`)
  const req = Object.assign(
    (async function* () { yield Buffer.from(JSON.stringify(body)) })(),
    { url: path },
  )
  let status = 0
  let text = ''
  const res = {
    writeHead: (code: number) => { status = code },
    end: (chunk: string) => { text = chunk },
  }
  return Promise.resolve(handler(req, res)).then(() => ({
    status,
    payload: JSON.parse(text) as Record<string, unknown>,
  }))
}

/** Write one section through the same service the plugin consumes. */
async function update(ctx: Context, patch: Record<string, unknown>): Promise<void> {
  const revision = ctx.settings.describe().find((row) => String(row.ns) === TARGET)?.revision
  await ctx.settings.update(TARGET, patch, revision)
}

const GATEWAY = {
  gateway: {
    api: 'openai-completions', baseURL: 'https://gw.example/v1',
    models: [{ id: 'deepseek-v4-flash' }, { id: 'glm-4.7' }],
  },
}
describe('integration: the discovery seam over the live llm service', () => {
  it('describes the models an endpoint advertises, so adopted rows arrive complete', async () => {
    const f = await fixture()
    // What a gateway listing actually discloses: ids and nothing else.
    f.llm.candidates = [{ id: 'deepseek-v4-flash' }, { id: 'glm-4.7' }]

    const found = await f.discover()
    assert.deepEqual(found, [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxTokens: 384_000, inputModalities: ['text'] },
      { id: 'glm-4.7', name: 'GLM-4.7', contextWindow: 204_800, maxTokens: 131_072, inputModalities: ['text'] },
    ])
    // Adopting them is an ordinary editor edit, so nothing was written here.
    assert.equal(f.events(), 0, 'describing a discovery writes no settings')
    await f.dispose()
  })

  it('adopting the described candidates persists exactly what the catalog said', async () => {
    const f = await fixture()
    f.llm.candidates = [{ id: 'deepseek-v4-flash' }]
    const found = await f.discover()

    // Mirror what ModelListEditor.adopt() does with a candidate: copy the
    // disclosed fields onto the row, then the card's 保存 commits it.
    const adopted = found.map((candidate) => ({
      id: candidate.id,
      ...candidate.name === undefined ? {} : { name: candidate.name },
      ...candidate.contextWindow === undefined ? {} : { contextWindow: candidate.contextWindow },
      ...candidate.maxTokens === undefined ? {} : { maxTokens: candidate.maxTokens },
      ...candidate.inputModalities === undefined ? {} : { input: [...candidate.inputModalities] },
    }))
    await update(f.ctx, { providers: { gateway: { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: adopted } } })

    const models = f.models()
    assert.equal(models[0]?.['id'], 'deepseek-v4-flash')
    assert.equal(models[0]?.['contextWindow'], 1_000_000)
    assert.equal(models[0]?.['maxTokens'], 384_000)
    assert.equal(models[0]?.['name'], 'DeepSeek V4 Flash')
    await f.dispose()
  })

  it('leaves a capacity the endpoint disclosed alone', async () => {
    // The endpoint's own numbers win: this only fills what discovery left open.
    const f = await fixture()
    f.llm.candidates = [{ id: 'deepseek-v4-flash', contextWindow: 65_536, name: 'My Gateway Label' }]

    const [only] = await f.discover()
    assert.equal(only?.['contextWindow'], 65_536, 'the disclosed window is kept')
    assert.equal(only?.['name'], 'My Gateway Label', 'the disclosed name is kept')
    // The fields discovery did not answer for are filled.
    assert.equal(only?.['maxTokens'], 384_000)
    await f.dispose()
  })

  it('returns a model the catalog does not know untouched, rather than guessing', async () => {
    const f = await fixture()
    f.llm.candidates = [{ id: 'my-private-model' }, { id: 'deepseek-v4-flash' }]

    const found = await f.discover()
    assert.deepEqual(found[0], { id: 'my-private-model' }, 'no invented metadata')
    assert.equal(found[1]?.['contextWindow'], 1_000_000)
    await f.dispose()
  })

  it('never adds a model the endpoint did not advertise', async () => {
    // Discovery answers what the endpoint serves; describing those answers must
    // not smuggle in a catalog entry the endpoint never mentioned.
    const f = await fixture()
    f.llm.candidates = [{ id: 'my-private-model' }]

    const found = await f.discover()
    assert.deepEqual(found.map((model) => model.id), ['my-private-model'])
    await f.dispose()
  })

  it('describes llm-pi-ai only, leaving another family untouched', async () => {
    const f = await fixture()
    // A real runtime needs a discovery registered for the namespace being
    // asked; this one serves another adapter family.
    f.ctx.llm.registerModelDiscovery('llm-other', async () => [{ id: 'deepseek-v4-flash' }])
    f.llm.candidates = [{ id: 'deepseek-v4-flash' }]

    const other = await f.discover('llm-other')
    assert.deepEqual(other, [{ id: 'deepseek-v4-flash' }], 'another namespace is not ours to size')
    await f.dispose()
  })

  it('propagates a discovery failure instead of answering with described rows', async () => {
    const f = await fixture()
    f.llm.failure = new Error('gateway refused the listing')
    await assert.rejects(() => f.discover(), /gateway refused the listing/)
    await f.dispose()
  })

  it('describes what the REMOTE path returns, which is the one the page uses', async () => {
    // The browser reaches discovery through the Remote adapter, and that adapter
    // calls `this.discoverModels` on the service instance. This is the assertion
    // that pins the wrap to the instance rather than to the context proxy.
    const f = await fixture()
    f.llm.candidates = [{ id: 'deepseek-v4-flash' }]

    const found = await f.ctx.llm.remoteDiscoverModels(
      TARGET,
      { baseURL: 'https://gw.example/v1' },
      new AbortController().signal,
    )
    assert.equal(found[0]?.['contextWindow'], 1_000_000)
    assert.equal(found[0]?.['name'], 'DeepSeek V4 Flash')
    await f.dispose()
  })

  it('restores discovery on disposal, leaving no shadow on the service', async () => {
    const f = await fixture()
    const service = f.ctx.get('llm')
    assert.ok(service, 'the runtime is mounted')
    // While mounted the plugin shadows the prototype method with its own.
    assert.ok(Object.hasOwn(service, 'discoverModels'), 'the wrap is an own property while mounted')
    await f.dispose()
    assert.equal(Object.hasOwn(service, 'discoverModels'), false, 'disposal removes the shadow')
  })

  it('calls through to the registered discovery exactly once', async () => {
    // A wrap that invoked itself instead of the captured previous method would
    // either recurse or double-ask the endpoint.
    const f = await fixture()
    f.llm.candidates = [{ id: 'deepseek-v4-flash' }]
    const found = await f.discover()
    assert.equal(f.llm.asks, 1, 'the registered discovery ran once')
    assert.equal(found.length, 1)
    await f.dispose()
  })

  it('writes nothing on boot, even with a section full of bare model ids', async () => {
    // The startup scan is gone: a boot that finds unenriched models leaves them
    // exactly as the user wrote them, and only a discovery describes anything.
    const f = await fixture({ providers: GATEWAY })
    await new Promise((resolve) => setTimeout(resolve, 600))

    assert.equal(f.events(), 0, 'no settings write happened at boot')
    // The resolved view materializes schema defaults (`input: []`), so assert on
    // the metadata this plugin would have filled rather than on the raw row.
    for (const model of f.models()) {
      assert.equal(model['contextWindow'], undefined, 'no capacity was filled')
      assert.equal(model['maxTokens'], undefined, 'no output cap was filled')
      assert.equal(model['name'], undefined, 'no display name was filled')
    }
    // Only the routes the user declared are in the user layer.
    assert.deepEqual(Object.keys(ctxBase(f.ctx) ?? {}), ['gateway'])
    await f.dispose()
  })

  it('the default catalog source is models.dev', () => {
    assert.deepEqual(resolveConfig(undefined).sources, ['models.dev'])
  })
})

describe('integration: the catalog lookup behind the fill controls', () => {
  it('answers with the fillable values and writes nothing', async () => {
    // The controls only READ: they put these into the editor's own fields and let
    // the card's 保存 commit. So after a lookup the user layer must be exactly as
    // it was — no write, no revision bump, nothing for the open card's 保存 to
    // conflict with, which is what lets the card stay open and savable.
    const f = await fixture({ providers: GATEWAY })
    const before = JSON.stringify(f.section())

    const result = await f.call('/model-meta-autofill/api/catalog?ids=deepseek-v4-flash', undefined)
    assert.equal(result.status, 200)
    assert.equal(result.payload['ok'], true)
    assert.deepEqual(result.payload['models'], {
      'deepseek-v4-flash': {
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        input: ['text'],
      },
    })
    assert.deepEqual(result.payload['unknown'], [])

    assert.equal(JSON.stringify(f.section()), before, 'a lookup must not touch the document')
    assert.equal(f.events(), 0, 'and must not emit a settings update')
    await f.dispose()
  })

  it('answers a whole card in one request, de-duplicated', async () => {
    // A provider-level fill covers every row, so one round trip is what keeps a
    // single button press from issuing a request per model.
    const f = await fixture({ providers: GATEWAY })
    const result = await f.call(
      '/model-meta-autofill/api/catalog?ids=deepseek-v4-flash,glm-4.7,deepseek-v4-flash',
      undefined,
    )
    assert.equal(result.status, 200)
    assert.deepEqual(Object.keys(result.payload['models'] as object).sort(), ['deepseek-v4-flash', 'glm-4.7'])
    assert.deepEqual(result.payload['unknown'], [])
    await f.dispose()
  })

  it('separates models the catalog does not know, and rejects a missing ids list', async () => {
    const f = await fixture({ providers: GATEWAY })
    const mixed = await f.call(
      '/model-meta-autofill/api/catalog?ids=deepseek-v4-flash,not-a-real-model-xyz',
      undefined,
    )
    // 200, because "the catalog does not know this model" is a fact the control
    // reports to the user, not a server error.
    assert.equal(mixed.status, 200)
    assert.deepEqual(Object.keys(mixed.payload['models'] as object), ['deepseek-v4-flash'])
    assert.deepEqual(mixed.payload['unknown'], ['not-a-real-model-xyz'])

    const noIds = await f.call('/model-meta-autofill/api/catalog', undefined)
    assert.equal(noIds.status, 400)
    assert.equal(noIds.payload['reason'], 'ids is required')
    await f.dispose()
  })
})

/** The user-layer `providers` of the target entry, when one exists. */
function ctxBase(ctx: Context): Record<string, unknown> | undefined {
  const user = ctx.settings.describe({ redactSecrets: true }).find((row) => String(row.ns) === TARGET)?.user
  return (user as { providers?: Record<string, unknown> } | undefined)?.providers
}
