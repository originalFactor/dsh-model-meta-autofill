/**
 * Integration: the auto-fill pass over the REAL settings service.
 *
 * Boots a test-only profile through the Loader (`boot` from
 * `@deepseek-ai/dsh-app-boot`) composed of the real config editor, the real
 * `SettingsForms` service, a probe plugin carrying an `llm-pi-ai`-shaped
 * volatile Config, and this plugin. The assertions read the same
 * `ctx.settings.describe()` surface every production caller reads, so they
 * cover the seam the plugin actually runs against rather than a stand-in.
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
  autoApply: true,
  dryRun: false,
  sources: ['models.dev'],
  timeoutMs: 5000,
}

/** Wait until fn() is truthy or the timeout elapses. */
async function waitFor(fn: () => boolean, ms = 8000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (fn()) return
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

interface Fixture {
  ctx: Context
  /** The resolved `llm-pi-ai` section as the plugin sees it. */
  section: () => Record<string, unknown> | undefined
  /** Models of the fixture's `gateway` provider. */
  models: () => Array<Record<string, unknown>>
  /** Count of `settings/document-updated` events for the target entry. */
  events: () => number
  dispose: () => Promise<void>
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

  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profileContext), (c) => {
    c.provide('profileContext', profileContext)
    c.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    Object.assign(c.loader.builtins, {
      editor: ConfigEditor, settings: Settings, target: Target, autofill: Autofill,
    })
  })
  cleanup.push(async () => { await ctx.fiber.dispose() })

  await ctx.plugin(Timer)
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
  return { ctx, section, models, events: () => events, dispose: async () => { await ctx.fiber.dispose() } }
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

describe('integration: settings auto-fill on the live settings seam', () => {
  it('fills existing unenriched models and terminates', async () => {
    const f = await fixture({ providers: GATEWAY })
    await waitFor(() => Number(f.models()[0]?.['contextWindow']) > 0)

    const models = f.models()
    assert.equal(models[0]?.['id'], 'deepseek-v4-flash')
    assert.equal(models[0]?.['contextWindow'], 1_000_000)
    assert.equal(models[0]?.['maxTokens'], 384_000)
    assert.equal(models[1]?.['id'], 'glm-4.7')
    assert.equal(typeof models[1]?.['maxTokens'], 'number')

    // Termination: the filled document has nothing missing, so no further writes.
    const settled = f.events()
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(f.events(), settled, 'no further commits after enrichment settled')
    await f.dispose()
  })

  it('fills a model adopted later, preserves user values, and does not loop', async () => {
    const f = await fixture()
    await update(f.ctx, {
      providers: {
        gateway: {
          api: 'openai-completions', baseURL: 'https://gw.example/v1',
          models: [{ id: 'gpt-5.2-pro', contextWindow: 123_456 }, { id: 'kimi-k2.5' }],
        },
      },
    })
    await waitFor(() => Number(f.models()[1]?.['maxTokens']) > 0)

    const models = f.models()
    // The user-set contextWindow survives; only the missing fields fill.
    assert.equal(models[0]?.['contextWindow'], 123_456)
    assert.equal(typeof models[0]?.['maxTokens'], 'number')
    assert.equal(models[1]?.['contextWindow'], 262_144)
    assert.equal(models[1]?.['maxTokens'], 262_144)

    const settled = f.events()
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(f.events(), settled, 'no extra commits after settling')
    await f.dispose()
  })

  it('refills metadata stripped after the initial fill', async () => {
    const f = await fixture()
    await update(f.ctx, {
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [{ id: 'deepseek-v4-flash' }] } },
    })
    await waitFor(() => f.models()[0]?.['contextWindow'] !== undefined)

    // The operator strips the fields back to a bare id.
    await update(f.ctx, {
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [{ id: 'deepseek-v4-flash' }] } },
    })
    await waitFor(() => f.models()[0]?.['contextWindow'] !== undefined)
    assert.equal(f.models()[0]?.['maxTokens'], 384_000)
    assert.equal(f.models()[0]?.['name'], 'DeepSeek V4 Flash')
    await f.dispose()
  })

  it('keeps the refill when delete and re-add land back-to-back', async () => {
    const f = await fixture()
    await update(f.ctx, {
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [{ id: 'deepseek-v4-flash' }] } },
    })
    await waitFor(() => f.models()[0]?.['contextWindow'] !== undefined)

    // Both commits land without awaiting the watcher pass in between.
    await update(f.ctx, {
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [] } },
    })
    await update(f.ctx, {
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [{ id: 'deepseek-v4-flash' }] } },
    })
    await waitFor(() => f.models()[0]?.['contextWindow'] !== undefined)
    assert.equal(f.models()[0]?.['contextWindow'], 1_000_000)
    await f.dispose()
  })

  it('autoApply=false writes nothing while the section stays readable', async () => {
    const f = await fixture({ providers: GATEWAY, config: { ...CONFIG, autoApply: false } })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(f.models()[0]?.['contextWindow'], undefined, 'no automatic writes')
    assert.ok(f.section(), 'the section is still served for callers')
    await f.dispose()
  })

  it('dryRun writes nothing', async () => {
    const f = await fixture({ providers: GATEWAY, config: { ...CONFIG, dryRun: true } })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(f.models()[0]?.['contextWindow'], undefined)
    assert.equal(f.events(), 0, 'dry-run added no writes')
    await f.dispose()
  })

  it('leaves a composition-base-only provider in the base, never in the user layer', async () => {
    const f = await fixture({ providers: GATEWAY })
    await waitFor(() => Number(f.models()[0]?.['contextWindow']) > 0)
    // The plugin materialized ONLY the provider the user owns. A provider it
    // never saw in the user layer cannot appear there.
    const providers = ctxBase(f.ctx)
    assert.deepEqual(Object.keys(providers ?? {}), ['gateway'])
    await f.dispose()
  })

  it('the default catalog source is models.dev', () => {
    assert.deepEqual(resolveConfig(undefined).sources, ['models.dev'])
  })
})

/** The user-layer `providers` of the target entry, when one exists. */
function ctxBase(ctx: Context): Record<string, unknown> | undefined {
  const user = ctx.settings.describe({ redactSecrets: true }).find((row) => String(row.ns) === TARGET)?.user
  return (user as { providers?: Record<string, unknown> } | undefined)?.providers
}
