import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  SettingsProvider, settingsNamespace,
  type SettingsNamespace,
} from '@deepseek-ai/dsh-settings'
import { apply as applyAutofill, resolveConfig } from '../../src/index.ts'

const NS: SettingsNamespace = settingsNamespace('llm-pi-ai')

/** In-memory settings provider implementing only the storage primitives. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>
  constructor(ctx: Context, options?: { doc?: Record<string, unknown> }) {
    super(ctx)
    this.doc = structuredClone(options?.doc ?? {})
  }
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
}

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
const sectionSchema = z.object({ providers: z.dict(profile).default({}) })

/** Section view helper: gateway models of the resolved llm-pi-ai section. */
function gatewayModels(ctx: Context): Array<Record<string, unknown>> {
  const section = ctx.settings.get(NS) as {
    providers?: Record<string, { models?: Array<Record<string, unknown>> }>
  }
  return section?.providers?.gateway?.models ?? []
}

/** Wait until fn() is truthy or the timeout elapses. */
async function waitFor(fn: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

const CONFIG = {
  enabled: true,
  refreshOnStart: false,
  autoApply: true,
  sources: ['models.dev'],
  timeoutMs: 5000,
}

describe('integration: settings auto-fill', () => {
  it('fills existing unenriched models on the initial scan and terminates', async () => {
    const ctx = new Context()
    const settingsFiber = ctx.plugin(MemorySettings, {})
    await settingsFiber
    const scope = ctx.settings.register(NS, sectionSchema)
    // Pre-existing user section: models listed with no metadata.
    await scope.update({
      providers: {
        gateway: {
          api: 'openai-completions', baseURL: 'https://gw.example/v1',
          models: [{ id: 'deepseek-v4-flash' }, { id: 'glm-4.7' }],
        },
      },
    })

    let writes = 0
    ctx.on('settings/updated', (ns, _n, _p, source) => {
      if (String(ns) === 'llm-pi-ai' && source === 'update') writes += 1
    })

    const autoFiber = ctx.plugin(applyAutofill, CONFIG)
    await autoFiber

    await waitFor(() => gatewayModels(ctx)[0]?.contextWindow !== undefined)

    const models = gatewayModels(ctx)
    assert.equal(models[0]!.id, 'deepseek-v4-flash')
    assert.equal(models[0]!.contextWindow, 1_000_000)
    assert.equal(models[0]!.maxTokens, 384_000)
    assert.equal(models[1]!.id, 'glm-4.7')
    assert.equal(models[1]!.contextWindow, 204_800)
    assert.equal(typeof models[1]!.maxTokens, 'number')

    // Termination: no further enrichment writes after settling.
    const writesAfter = writes
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(writes, writesAfter, 'no further writes after enrichment settled')
    await autoFiber.dispose()
    await settingsFiber.dispose()
  })

  it('fills a model adopted after the initial scan, preserves user values, and does not loop', async () => {
    const ctx = new Context()
    const settingsFiber = ctx.plugin(MemorySettings, {})
    await settingsFiber
    const scope = ctx.settings.register(NS, sectionSchema)
    const autoFiber = ctx.plugin(applyAutofill, CONFIG)
    await autoFiber

    // The Models page adopts a new model with a user-set context window.
    await scope.update({
      providers: {
        gateway: {
          api: 'openai-completions',
          baseURL: 'https://gw.example/v1',
          models: [
            { id: 'gpt-5.2-pro', contextWindow: 123_456 },
            { id: 'kimi-k2.5' },
          ],
        },
      },
    })

    await waitFor(() => Number(gatewayModels(ctx)[1]?.maxTokens) > 0)

    const models = gatewayModels(ctx)
    const gpt = models[0]!
    const kimi = models[1]!
    // User-set contextWindow preserved, other fields filled.
    assert.equal(gpt.contextWindow, 123_456)
    assert.equal(typeof gpt.maxTokens, 'number')
    assert.equal(kimi.contextWindow, 262_144)
    assert.equal(kimi.maxTokens, 262_144)

    // Stability: repeated observation produces no further commits.
    const marks: string[] = []
    ctx.on('settings/updated', (ns) => { if (String(ns) === 'llm-pi-ai') marks.push(String(ns)) })
    const beforeCount = marks.length
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(marks.length, beforeCount, 'no extra commits after settling')
    await autoFiber.dispose()
    await settingsFiber.dispose()
  })

  it('dry-run mode writes nothing', async () => {
    const ctx = new Context()
    const settingsFiber = ctx.plugin(MemorySettings, {})
    await settingsFiber
    const scope = ctx.settings.register(NS, sectionSchema)
    await scope.update({
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [{ id: 'deepseek-v4-flash' }] } },
    })
    let writes = 0
    ctx.on('settings/updated', (ns) => { if (String(ns) === 'llm-pi-ai') writes += 1 })
    const autoFiber = ctx.plugin(applyAutofill, { ...CONFIG, dryRun: true })
    await autoFiber
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(gatewayModels(ctx)[0]?.contextWindow, undefined)
    assert.equal(writes, 0, 'dry-run added no writes')
    await autoFiber.dispose()
    await settingsFiber.dispose()
  })

  it('the default catalog sources are models.dev first', () => {
    assert.deepEqual(resolveConfig(undefined).sources, ['models.dev'])
  })

  it('composition-base-only providers are never materialized', async () => {
    const ctx = new Context()
    const settingsFiber = ctx.plugin(MemorySettings, {})
    await settingsFiber
    // llm-pi-ai mounted "dormant": the only provider lives in composition base.
    ctx.settings.register(NS, sectionSchema, {
      base: {
        providers: {
          'base-only': {
            apiKeyEnv: 'DUMMY_KEY',
            api: 'openai-completions',
            baseURL: 'https://x/v1',
            modelOverrides: Object.create(null) as never,
            models: [{
              id: 'deepseek-v4-flash', name: 'placeholder', contextWindow: 10, maxTokens: 10, input: ['text'],
            }],
          },
        },
      },
    })
    const autoFiber = ctx.plugin(applyAutofill, CONFIG)
    await autoFiber
    await new Promise((resolve) => setTimeout(resolve, 400))
    // The user document must not have grown: the base-only provider stays in
    // the composition base, and nothing base-derived is copied into storage.
    const provider = ctx.get('settings') as MemorySettings
    assert.equal(provider.doc['llm-pi-ai'], undefined)
    await autoFiber.dispose()
    await settingsFiber.dispose()
  })

  it('refills a model whose metadata was stripped after the initial fill (delete-then-refill)', async () => {
    const ctx = new Context()
    const settingsFiber = ctx.plugin(MemorySettings, {})
    await settingsFiber
    const scope = ctx.settings.register(NS, sectionSchema)
    const autoFiber = ctx.plugin(applyAutofill, CONFIG)
    await autoFiber

    // Initial fill of a bare model.
    await scope.update({
      providers: {
        gateway: {
          api: 'openai-completions', baseURL: 'https://gw.example/v1',
          models: [{ id: 'deepseek-v4-flash' }],
        },
      },
    })
    await waitFor(() => gatewayModels(ctx)[0]?.contextWindow !== undefined)
    assert.equal(gatewayModels(ctx)[0]!.contextWindow, 1_000_000)

    // User strips the metadata (leaves only id + compat, as if re-added bare).
    await scope.update({
      providers: {
        gateway: {
          api: 'openai-completions', baseURL: 'https://gw.example/v1',
          models: [{ id: 'deepseek-v4-flash', compat: {} }],
        },
      },
    })
    // Immediately after the strip the fields are gone.
    assert.equal(gatewayModels(ctx)[0]?.contextWindow, undefined)

    // The watcher must refill them.
    await waitFor(() => gatewayModels(ctx)[0]?.contextWindow !== undefined)
    assert.equal(gatewayModels(ctx)[0]!.contextWindow, 1_000_000)
    assert.equal(gatewayModels(ctx)[0]!.maxTokens, 384_000)
    assert.equal(gatewayModels(ctx)[0]!.name, 'DeepSeek V4 Flash')

    await autoFiber.dispose()
    await settingsFiber.dispose()
  })

  it('does not lose the refill when delete and re-add land back-to-back (inflight coalescing rescan)', async () => {
    const ctx = new Context()
    const settingsFiber = ctx.plugin(MemorySettings, {})
    await settingsFiber
    const scope = ctx.settings.register(NS, sectionSchema)
    const autoFiber = ctx.plugin(applyAutofill, CONFIG)
    await autoFiber

    await scope.update({
      providers: {
        gateway: {
          api: 'openai-completions', baseURL: 'https://gw.example/v1',
          models: [{ id: 'deepseek-v4-flash' }],
        },
      },
    })
    await waitFor(() => gatewayModels(ctx)[0]?.contextWindow !== undefined)

    // Fire delete and re-add back-to-back WITHOUT awaiting the watcher pass in
    // between: the second commit lands while the first pass is still in flight,
    // so the coalescing logic must remember it and rescan after settling.
    await scope.update({
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [] } },
    })
    await scope.update({
      providers: { gateway: { api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [{ id: 'deepseek-v4-flash' }] } },
    })

    // The re-added bare entry must still get filled once the rescan runs.
    await waitFor(() => gatewayModels(ctx)[0]?.contextWindow !== undefined)
    assert.equal(gatewayModels(ctx)[0]!.contextWindow, 1_000_000)
    assert.equal(gatewayModels(ctx)[0]!.maxTokens, 384_000)

    await autoFiber.dispose()
    await settingsFiber.dispose()
  })
})
