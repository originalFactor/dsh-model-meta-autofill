import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  catalogView, catalogViews, displayName, listProviders, splitVendorName, type LlmPiAiSection,
} from '../src/api.ts'

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
    other: { models: [{ id: 'known-model' }] },
  },
}


describe('listProviders', () => {
  it('reports each route with the title and rows its card renders', () => {
    // The browser half injects into rendered cards, which show only the title,
    // so this map is what lets it recover the route id a write must name. The
    // rows are what a card reload compares against to prove the editor really
    // re-seeded (the page's store lags an external write).
    const rows: LlmPiAiSection = {
      providers: {
        workbuddy: { displayName: 'WorkBuddy', models: [{ id: 'x', name: 'X' }, { id: 'y' }] },
        gateway: { models: [{ id: 'z' }] },
      },
    }
    assert.deepEqual(listProviders(rows, undefined), [
      // A row carries its name only when the profile declares one.
      { provider: 'workbuddy', displayName: 'WorkBuddy', models: [{ id: 'x', name: 'X' }, { id: 'y' }] },
      // A route with no declared title falls back to its own id, which is what
      // the card shows in that case.
      { provider: 'gateway', displayName: 'gateway', models: [{ id: 'z' }] },
    ])
  })

  it('lists only user-layer routes and tolerates an absent section', () => {
    // Capacities travel with the rows, because a card reload compares the
    // reopened editor's capacity inputs against them.
    assert.deepEqual(
      listProviders(section, new Set(['gw'])),
      [{
        provider: 'gw',
        displayName: 'gw',
        models: [
          { id: 'known-model', contextWindow: 999, maxTokens: 7 },
          { id: 'unknown-model' },
        ],
      }],
    )
    assert.deepEqual(listProviders(section, new Set(['nobody'])), [])
    assert.deepEqual(listProviders(undefined, undefined), [])
  })

  it('carries each row capacity only when the profile declares one', () => {
    // A reload compares capacities, so an absent one must stay absent rather
    // than defaulting to a number that would never match the rendered blank.
    const rows: LlmPiAiSection = {
      providers: {
        gw: {
          models: [
            { id: 'full', contextWindow: 1_000_000, maxTokens: 384_000 },
            { id: 'context-only', contextWindow: 128_000 },
            { id: 'bare' },
          ],
        },
      },
    }
    assert.deepEqual(listProviders(rows, undefined), [{
      provider: 'gw',
      displayName: 'gw',
      models: [
        { id: 'full', contextWindow: 1_000_000, maxTokens: 384_000 },
        { id: 'context-only', contextWindow: 128_000 },
        { id: 'bare' },
      ],
    }])
  })

  it('skips rows with no usable id rather than reporting a phantom model', () => {
    // The reload matches the editor's rows positionally, so a row it cannot
    // identify must not enter the expectation at all.
    const malformed: LlmPiAiSection = {
      providers: { gw: { models: [{ id: '' }, { name: 'no id' } as never, { id: 'real' }] } },
    }
    assert.deepEqual(listProviders(malformed, undefined), [
      { provider: 'gw', displayName: 'gw', models: [{ id: 'real' }] },
    ])
  })
})

describe('catalogView', () => {
  it('returns exactly the fillable values, with no write and no padding', () => {
    // The per-model control puts these into the editor's own fields, so a field
    // the catalog does not know must be ABSENT rather than present-but-empty:
    // an empty string would clear a value the user had set.
    assert.deepEqual(catalogView(lookup, 'known-model'), {
      id: 'known-model',
      name: 'Known Model',
      contextWindow: 100,
      maxTokens: 50,
      input: ['text', 'image'],
    })
    assert.deepEqual(catalogView(lookup, 'partial-model'), { id: 'partial-model', contextWindow: 200 })
  })

  it('answers undefined for a model the catalog does not know', () => {
    assert.equal(catalogView(lookup, 'unknown-model'), undefined)
  })

  it('honors the vendor name style', () => {
    const vendorMeta = { id: 'v', name: 'OpenAI/GPT-5.2', vendor: 'OpenAI' }
    assert.equal(catalogView(() => vendorMeta, 'v', 'vendor')?.['name'], 'OpenAI: GPT-5.2')
    assert.equal(catalogView(() => vendorMeta, 'v', 'bare')?.['name'], 'GPT-5.2')
  })
})

describe('catalogViews', () => {
  it('answers many ids in one pass, keyed by the id asked about', () => {
    // A provider-level fill covers every row of a card, so this is what keeps it
    // to ONE round trip instead of a request per model.
    assert.deepEqual(catalogViews(lookup, ['known-model', 'partial-model']), {
      ok: true,
      models: {
        'known-model': { id: 'known-model', name: 'Known Model', contextWindow: 100, maxTokens: 50, input: ['text', 'image'] },
        'partial-model': { id: 'partial-model', contextWindow: 200 },
      },
      unknown: [],
    })
  })

  it('separates ids the catalog does not know from the ones it does', () => {
    // A gap is reported, never filled with a guess.
    const result = catalogViews(lookup, ['known-model', 'unknown-model'])
    assert.deepEqual(Object.keys(result.models), ['known-model'])
    assert.deepEqual(result.unknown, ['unknown-model'])
  })

  it('de-duplicates ids and skips blanks', () => {
    // Blanks are unnamed rows, not catalog gaps, and a repeated id must not
    // become two entries or two "unknown" reports.
    const result = catalogViews(lookup, ['known-model', 'known-model', '', 'unknown-model', 'unknown-model'])
    assert.deepEqual(Object.keys(result.models), ['known-model'])
    assert.deepEqual(result.unknown, ['unknown-model'])
  })

  it('keeps unknown ids in the order they were asked about', () => {
    const result = catalogViews(lookup, ['nope-b', 'known-model', 'nope-a'])
    assert.deepEqual(result.unknown, ['nope-b', 'nope-a'])
  })

  it('honors the vendor name style', () => {
    const vendorMeta = { id: 'v', name: 'OpenAI/GPT-5.2', vendor: 'OpenAI' }
    assert.equal(catalogViews(() => vendorMeta, ['v'], 'vendor').models['v']?.['name'], 'OpenAI: GPT-5.2')
    assert.equal(catalogViews(() => vendorMeta, ['v'], 'bare').models['v']?.['name'], 'GPT-5.2')
  })

  it('answers empty lists rather than failing on no ids', () => {
    assert.deepEqual(catalogViews(lookup, []), { ok: true, models: {}, unknown: [] })
    assert.deepEqual(catalogViews(lookup, ['', '']), { ok: true, models: {}, unknown: [] })
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
