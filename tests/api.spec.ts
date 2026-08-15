import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyAll, applyReasoning, applyRow, displayName, listReasoning, listRows, splitVendorName, type LlmPiAiSection } from '../src/api.ts'

const meta = {
  known: { id: 'known-model', name: 'Known Model', vendor: 'TestVendor', contextWindow: 100, maxTokens: 50, input: ['text', 'image'] as const },
  partial: { id: 'partial-model', contextWindow: 200 },
}
function lookup(id: string) {
  if (id === 'known-model') return meta.known
  if (id === 'partial-model') return meta.partial
  return undefined
}
const section: LlmPiAiSection = {
  providers: {
    gw: {
      api: 'openai-completions', baseURL: 'https://gw.example/v1',
      models: [
        { id: 'known-model', contextWindow: 999, maxTokens: 7, compat: {} },
        { id: 'unknown-model' },
      ],
      modelOverrides: { 'partial-model': { maxTokens: 3 } },
    },
  },
}

describe('listRows', () => {
  it('reports matched/unmatched models with catalog and configured snapshots', () => {
    const rows = listRows(section, lookup, new Set(['gw']))
    assert.equal(rows.length, 1)
    const gw = rows[0]!
    assert.equal(gw.provider, 'gw')
    assert.equal(gw.userConfigured, true)
    // 2 list entries + 1 override
    assert.equal(gw.models.length, 3)
    const known = gw.models.find(m => m.id === 'known-model')!
    assert.equal(known.matched, true)
    assert.equal(known.catalog?.contextWindow, 100)
    assert.equal(known.configured.contextWindow, 999)
    const unknown = gw.models.find(m => m.id === 'unknown-model')!
    assert.equal(unknown.matched, false)
    assert.equal(unknown.catalog, undefined)
  })

  it('flags non-user providers and empty section', () => {
    const rows = listRows(section, lookup, new Set(['other']))
    assert.equal(rows[0]!.userConfigured, false)
    assert.deepEqual(listRows(undefined, lookup), [])
  })
})

describe('applyRow', () => {
  it('overwrite=true switches configured values to the catalog ones', () => {
    const result = applyRow(section, lookup, new Set(['gw']), 'gw', 'known-model')
    assert.equal(result.ok, true)
    assert.equal(result.applied?.name, 'Known Model')
    assert.equal(result.applied?.contextWindow, 100)
    const providers = result.patch!.providers as Record<string, unknown>
    const gw = providers.gw as Record<string, unknown>
    const models = gw.models as Array<Record<string, unknown>>
    assert.equal(models.length, 2)
    const entry = models[0]!
    assert.equal(entry.contextWindow, 100)
    assert.equal(entry.maxTokens, 50)
    assert.deepEqual(entry.input, ['text', 'image'])
    // untouched fields survive (compat kept), sibling model restated
    assert.deepEqual(entry.compat, {})
    assert.equal(models[1]!.id, 'unknown-model')
  })

  it('overwrite=false fills only missing fields', () => {
    const result = applyRow(section, lookup, new Set(['gw']), 'gw', 'known-model', false)
    const providers = result.patch!.providers as Record<string, unknown>
    const gw = providers.gw as Record<string, unknown>
    const entry = (gw.models as Array<Record<string, unknown>>)[0]!
    assert.equal(entry.contextWindow, 999)   // user value preserved
    assert.equal(entry.maxTokens, 7)          // user value preserved
    assert.equal(entry.name, 'Known Model')   // missing, now filled
  })

  it('catalog gaps keep the configured value (never erases)', () => {
    const result = applyRow(section, lookup, new Set(['gw']), 'gw', 'partial-model')
    const providers = result.patch!.providers as Record<string, unknown>
    const gw = providers.gw as Record<string, unknown>
    const overrides = gw.modelOverrides as Record<string, Record<string, unknown>>
    const entry = overrides['partial-model']!
    assert.equal(entry.contextWindow, 200)    // from catalog
    assert.equal(entry.maxTokens, 3)          // catalog has no output cap
  })

  it('reports the precise reason on every failure mode', () => {
    assert.equal(applyRow(section, lookup, new Set(['other']), 'gw', 'known-model').reason, 'provider-not-configured')
    assert.equal(applyRow(section, lookup, new Set(['gw']), 'missing-gw', 'known-model').reason, 'provider-not-configured')
    assert.equal(applyRow(section, lookup, new Set(['ghost']), 'ghost', 'known-model').reason, 'provider-not-found')
    assert.equal(applyRow(section, lookup, new Set(['gw']), 'gw', 'no-such').reason, 'no-match')
    assert.equal(applyRow(section, lookup, new Set(['gw']), 'gw', 'partial-model').reason, undefined)
    assert.equal(applyRow(undefined, lookup, undefined, 'gw', 'known-model').reason, 'provider-not-found')
  })

  it('model-not-found when the route has the model neither listed nor overridden', () => {
    const noModels: LlmPiAiSection = { providers: { gw: { api: 'x', baseURL: 'y' } } }
    assert.equal(applyRow(noModels, lookup, new Set(['gw']), 'gw', 'known-model').reason, 'model-not-found')
  })
})

describe('name formatting', () => {
  it('splitVendorName recovers a baked-in vendor prefix', () => {
    assert.deepEqual(splitVendorName('OpenAI/GPT-5.2', undefined), { vendor: 'OpenAI', bare: 'GPT-5.2' })
    assert.deepEqual(splitVendorName('GPT-5.2', 'OpenAI'), { vendor: 'OpenAI', bare: 'GPT-5.2' })
    assert.deepEqual(splitVendorName(undefined, 'OpenAI'), {})
  })

  it('displayName honors the vendor style', () => {
    const m = { name: 'OpenAI/GPT-5.2', vendor: 'OpenAI' }
    assert.equal(displayName(m, 'vendor'), 'OpenAI: GPT-5.2')
    assert.equal(displayName(m, 'bare'), 'GPT-5.2')
    assert.equal(displayName({}, 'vendor'), undefined)
  })
})

describe('applyRow nameStyle', () => {
  it('vendor style writes the prefixed display name', () => {
    const result = applyRow(section, lookup, new Set(['gw']), 'gw', 'known-model', true, 'vendor')
    const providers = result.patch!.providers as Record<string, unknown>
    const gw = providers.gw as Record<string, unknown>
    const entry = (gw.models as Array<Record<string, unknown>>)[0]!
    assert.equal(entry.name, 'TestVendor: Known Model')
    assert.equal(result.applied?.name, 'TestVendor: Known Model')
  })

  it('bare style strips the prefix', () => {
    const result = applyRow(section, lookup, new Set(['gw']), 'gw', 'known-model', true, 'bare')
    assert.equal(result.applied?.name, 'Known Model')
  })
})

describe('applyAll', () => {
  it('builds one patch overwriting every matched model and reports misses', () => {
    const result = applyAll(section, lookup, new Set(['gw']), 'vendor')
    assert.equal(result.ok, true)
    assert.deepEqual(result.filled.map((f) => f.modelId).sort(), ['known-model', 'partial-model'])
    assert.deepEqual(result.missed.map((m) => m.modelId), ['unknown-model'])
    const providers = result.patch!.providers as Record<string, unknown>
    const gw = providers.gw as Record<string, unknown>
    const models = gw.models as Array<Record<string, unknown>>
    assert.equal(models.length, 2)
    const known = models.find((m) => m.id === 'known-model')!
    assert.equal(known.name, 'TestVendor: Known Model')
    assert.equal(known.contextWindow, 100)
    // the unmatched model is restated untouched
    assert.equal(models.find((m) => m.id === 'unknown-model')!.contextWindow, undefined)
    // the override entry is patched per key
    const overrides = gw.modelOverrides as Record<string, Record<string, unknown>>
    assert.equal(overrides['partial-model']!.contextWindow, 200)
    assert.equal(overrides['partial-model']!.maxTokens, 3)
  })

  it('skips providers outside the user layer', () => {
    const result = applyAll(section, lookup, new Set(['other']))
    assert.equal(result.patch, undefined)
    assert.equal(result.filled.length, 0)
  })
})

describe('reasoning declaration', () => {
  const rSection: LlmPiAiSection = {
    providers: {
      gw: {
        api: 'openai-completions', baseURL: 'https://gw.example/v1',
        compat: { thinkingFormat: 'openai' },
        models: [
          { id: 'reason-model', reasoningEfforts: { off: null, high: 'high' } },
          { id: 'plain-model' },
        ],
        modelOverrides: { 'override-model': { reasoningEfforts: false } },
      },
    },
  }
  const rLookup = (id: string) => {
    if (id === 'reason-model') return { id, contextWindow: 100, reasoning: true, reasoningLevels: ['low', 'high'] }
    if (id === 'plain-model') return { id, contextWindow: 50, reasoning: true }
    return undefined
  }

  it('listReasoning reports protocol, declared efforts, and presets', () => {
    const views = listReasoning(rSection, rLookup, new Set(['gw']))
    assert.equal(views.length, 1)
    const gw = views[0]!
    assert.equal(gw.api, 'openai-completions')
    assert.equal(gw.thinkingFormat, 'openai')
    assert.equal(gw.models.length, 3)
    const reason = gw.models.find((m) => m.id === 'reason-model')!
    assert.deepEqual(reason.declared, { off: null, high: 'high' })
    assert.deepEqual(reason.preset, ['off', 'low', 'high'])
    assert.equal(reason.isList, true)
    const plain = gw.models.find((m) => m.id === 'plain-model')!
    assert.equal(plain.declared, undefined)
    assert.deepEqual(plain.preset, ['off', 'high'])
    const override = gw.models.find((m) => m.id === 'override-model')!
    assert.equal(override.declared, false)
    assert.equal(override.isList, false)
  })

  it('skips providers outside the user layer', () => {
    assert.deepEqual(listReasoning(rSection, rLookup, new Set(['other'])), [])
  })

  it('writes the route-level thinkingFormat on an openai-completions route', () => {
    const result = applyReasoning(rSection, new Set(['gw']), 'gw', undefined, 'deepseek')
    assert.equal(result.ok, true)
    const providers = result.patch!.providers as Record<string, unknown>
    const gw = providers.gw as Record<string, unknown>
    assert.deepEqual(gw.compat, { thinkingFormat: 'deepseek' })
    // the rest of the profile rides along (array-replace safety)
    assert.equal((gw.models as unknown[]).length, 2)
  })

  it('pre-emptively rejects thinkingFormat on non-completions protocols', () => {
    const responses: LlmPiAiSection = {
      providers: { gw: { api: 'openai-responses', baseURL: 'https://gw.example/v1', models: [{ id: 'm' }] } },
    }
    const result = applyReasoning(responses, new Set(['gw']), 'gw', undefined, 'openai')
    assert.equal(result.ok, false)
    assert.ok((result.reason ?? '').includes('openai-completions'))
    assert.ok((result.reason ?? '').includes('openai-responses'))
    // per-model efforts are still accepted — that is the native path
    const efforts = applyReasoning(responses, new Set(['gw']), 'gw', 'm', { off: null, high: 'high' })
    assert.equal(efforts.ok, true)
    // a route without an api is rejected too (unprovable protocol)
    const noApi: LlmPiAiSection = { providers: { gw: { models: [{ id: 'm' }] } } }
    assert.equal(applyReasoning(noApi, new Set(['gw']), 'gw', undefined, 'openai').ok, false)
  })

  it('writes a list model reasoningEfforts declaration', () => {
    const result = applyReasoning(rSection, new Set(['gw']), 'gw', 'reason-model', { off: null, low: 'low', high: 'high' })
    assert.equal(result.ok, true)
    const providers = result.patch!.providers as Record<string, unknown>
    const gw = providers.gw as Record<string, unknown>
    const models = gw.models as Array<Record<string, unknown>>
    assert.deepEqual(models[0]!.reasoningEfforts, { off: null, low: 'low', high: 'high' })
    assert.equal(models[1]!.id, 'plain-model')
  })

  it('writes an override reasoningEfforts declaration', () => {
    const result = applyReasoning(rSection, new Set(['gw']), 'gw', 'override-model', false)
    assert.equal(result.ok, true)
    const providers = result.patch!.providers as Record<string, unknown>
    const gw = providers.gw as Record<string, unknown>
    const overrides = gw.modelOverrides as Record<string, Record<string, unknown>>
    assert.equal(overrides['override-model']!.reasoningEfforts, false)
  })

  it('rejects bad declarations and non-user providers', () => {
    assert.ok((applyReasoning(rSection, new Set(['gw']), 'gw', 'reason-model', {}).reason ?? '').includes('字典'))
    assert.ok((applyReasoning(rSection, new Set(['gw']), 'gw', 'reason-model', { turbo: 'x' }).reason ?? '').includes('turbo'))
    assert.ok((applyReasoning(rSection, new Set(['gw']), 'gw', 'reason-model', { high: '' }).reason ?? '').includes('high'))
    assert.equal(applyReasoning(rSection, new Set(['other']), 'gw', 'reason-model', { high: 'high' }).reason, 'provider-not-configured')
    assert.equal(applyReasoning(rSection, new Set(['gw', 'ghost']), 'ghost', 'reason-model', { high: 'high' }).reason, 'provider-not-found')
    assert.equal(applyReasoning(rSection, new Set(['gw']), 'gw', 'nope', { high: 'high' }).reason, 'model-not-found')
  })
})
