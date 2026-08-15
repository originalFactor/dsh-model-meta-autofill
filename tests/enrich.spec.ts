import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSectionPatch, cleanEntry, fillsFor, listMissing,
  type LlmPiAiSection, type ModelHead,
} from '../src/enrich.ts'
import type { LookedUpEntry } from '../src/dataset.ts'

const OPTS = { fillName: true, fillInput: true }

const meta: LookedUpEntry = {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  input: ['text', 'image'],
  reasoning: true,
}

function lookup(id: string): LookedUpEntry | undefined {
  return id === 'deepseek-v4-flash' ? meta : undefined
}

describe('fillsFor', () => {
  it('fills only missing fields and never overwrites configured ones', () => {
    const all: ModelHead = {}
    assert.deepEqual(fillsFor(all, meta, OPTS), {
      name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'],
    })
    const partial: ModelHead = { contextWindow: 999, maxTokens: 42 }
    assert.deepEqual(fillsFor(partial, meta, OPTS), { name: 'DeepSeek V4 Flash', input: ['text', 'image'] })
    const full: ModelHead = { name: 'x', contextWindow: 1, maxTokens: 1, input: ['text'] }
    assert.equal(fillsFor(full, meta, OPTS), undefined)
  })

  it('respects fill toggles', () => {
    const empty: ModelHead = {}
    assert.deepEqual(fillsFor(empty, meta, { fillName: false, fillInput: false }), {
      contextWindow: 1_000_000, maxTokens: 128_000,
    })
    const noName = fillsFor(empty, meta, { fillName: false, fillInput: true })
    assert.equal(noName?.name, undefined)
  })

  it('skips unknown models entirely', () => {
    assert.equal(fillsFor({} as ModelHead, lookup('no-such-model'), OPTS), undefined)
  })
})

describe('cleanEntry', () => {
  it('cleans schema-materialized noise (empty input, undefined)', () => {
    const cleaned = cleanEntry({ id: 'x', input: [], contextWindow: undefined } as never)
    assert.deepEqual(cleaned, { id: 'x' })
  })
})

describe('buildSectionPatch', () => {
  const section: LlmPiAiSection = {
    providers: {
      gateway: {
        api: 'openai-completions',
        baseURL: 'https://gw.example/v1',
        models: [
          { id: 'deepseek-v4-flash' },
          { id: 'gpt-5.2-pro', contextWindow: 400_000 },
          { id: 'unknown-model' },
        ],
        modelOverrides: {
          'deepseek-v4-flash': { maxTokens: 64 },
          'gpt-5.2-pro': { maxTokens: 99 },
        },
      },
      untouched: { models: [{ id: 'no-catalog-model' }] },
    },
  }

  function gatewayOf(patch: Record<string, unknown>): Record<string, unknown> {
    const providers = patch.providers as Record<string, unknown> | undefined
    return (providers?.gateway ?? {}) as Record<string, unknown>
  }

  it('produces a sparse patch that restates changed models lists wholesale', () => {
    const patch = buildSectionPatch(section, lookup, OPTS)
    assert.ok(patch, 'expected a patch')
    const gateway = gatewayOf(patch!)
    const models = gateway.models as Record<string, unknown>[]
    assert.equal(models.length, 3)
    const dsv4 = models[0] as Record<string, unknown>
    assert.equal(dsv4.contextWindow, 1_000_000)
    assert.equal(dsv4.maxTokens, 128_000)
    const gpt = models[1] as Record<string, unknown>
    // configured contextWindow preserved; maxTokens untouched because the
    // (fake) catalog has no entry for gpt-5.2-pro — never guessed.
    assert.equal(gpt.contextWindow, 400_000)
    assert.equal(gpt.maxTokens, undefined)
    // unknown stays unknown (no guess)
    assert.deepEqual(models[2], { id: 'unknown-model' })
    const providers = patch!.providers as Record<string, unknown>
    assert.equal(providers.untouched, undefined)
  })

  it('includes only changed modelOverrides entries (configured values preserved)', () => {
    const patch = buildSectionPatch(section, lookup, OPTS)
    const gateway = gatewayOf(patch!)
    const overrides = gateway.modelOverrides as Record<string, unknown>
    assert.ok(overrides['deepseek-v4-flash'])
    assert.equal((overrides['deepseek-v4-flash'] as Record<string, unknown>).contextWindow, 1_000_000)
    assert.equal((overrides['deepseek-v4-flash'] as Record<string, unknown>).maxTokens, 64)
    // gpt-5.2-pro has no catalog entry here, so its override stays untouched.
    assert.equal(overrides['gpt-5.2-pro'], undefined)
  })

  it('honors userProviderIds filtering', () => {
    const patch = buildSectionPatch(section, lookup, OPTS, new Set(['gateway']))
    assert.ok(patch)
    const providers = patch!.providers as Record<string, unknown>
    assert.equal(providers.untouched, undefined)
    assert.ok((providers.gateway as Record<string, unknown> | undefined)?.models)
  })

  it('returns undefined when nothing is missing (termination guarantee)', () => {
    const full: LlmPiAiSection = {
      providers: {
        gateway: {
          models: [{
            id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash',
            contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'],
          }],
        },
      },
    }
    assert.equal(buildSectionPatch(full, lookup, OPTS), undefined)
  })

  it('returns undefined for an empty/absent section', () => {
    assert.equal(buildSectionPatch(undefined, lookup, OPTS), undefined)
    assert.equal(buildSectionPatch({}, lookup, OPTS), undefined)
  })
})

describe('listMissing', () => {
  it('reports what remains unfilled', () => {
    const missing = listMissing(
      { providers: { g: { models: [{ id: 'deepseek-v4-flash' }, { id: 'other' }] } } },
      lookup, OPTS,
    )
    assert.equal(missing.length, 1)
    assert.equal(missing[0]?.id, 'deepseek-v4-flash')
    assert.ok(missing[0]?.fields.includes('contextWindow'))
  })
})
