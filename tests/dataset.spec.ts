import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ModelMetaIndex, aliasesOf, collectEntries, dedupeSizedEntries, normalizeEntry, parseReasoningOptions,
} from '../src/dataset.ts'

describe('normalizeEntry', () => {
  it('reads context/output limits, name, input, reasoning, vision', () => {
    const entry = normalizeEntry({
      id: 'gemini-3-flash-preview',
      name: 'Gemini 3 Flash',
      display_name: 'Gemini 3 Flash',
      modalities: { input: ['text', 'image', 'audio'], output: ['text'] },
      limit: { context: 1_048_576, output: 65_536 },
      reasoning: { supported: true, default: true },
      vision: true,
    })
    assert.deepEqual(entry, {
      id: 'gemini-3-flash-preview',
      name: 'Gemini 3 Flash',
      contextWindow: 1_048_576,
      maxTokens: 65_536,
      input: ['text', 'image'],
      reasoning: true,
      vision: true,
    })
  })

  it('drops entries without any capacity', () => {
    assert.equal(normalizeEntry({ id: 'mystery' }), undefined)
    assert.equal(normalizeEntry(null), undefined)
    assert.equal(normalizeEntry('nope'), undefined)
  })

  it('does not add text input when nothing is declared', () => {
    const entry = normalizeEntry({
      id: 'm', limit: { context: 100, output: 100 },
    })
    assert.equal(entry?.input, undefined)
  })

  it('maps only text/image onto pi-ai modalities; vision implies image', () => {
    const visionOnly = normalizeEntry({
      id: 'v', limit: { context: 10, output: 10 }, vision: true,
    })
    assert.deepEqual(visionOnly?.input, ['text', 'image'])
    // Non-representable modalities still imply the text floor.
    const audioOnly = normalizeEntry({
      id: 'a', limit: { context: 10, output: 10 },
      modalities: { input: ['audio'] }, vision: false,
    })
    assert.deepEqual(audioOnly?.input, ['text'])
  })
})

describe('collectEntries', () => {
  it('walks a provider-file shape and an all.json providers dict', () => {
    const list = collectEntries({ models: [{ id: 'x', limit: { context: 1, output: 1 } }] })
    assert.equal(list.length, 1)
    const dict = collectEntries({
      providers: {
        requesty: { models: [{ id: 'a/b', limit: { context: 2, output: 2 } }] },
      },
    })
    assert.equal(dict.length, 1)
    assert.equal(dict[0]?.id, 'a/b')
  })
})

describe('ModelMetaIndex', () => {
  it('resolves exact, lowercase, prefix-stripped and tilde-stripped aliases', () => {
    const index = new ModelMetaIndex([{ id: 'anthropic/claude-opus-4-5', contextWindow: 200_000, maxTokens: 200_000 }])
    for (const id of ['anthropic/claude-opus-4-5', 'claude-opus-4-5', 'Anthropic/Claude-Opus-4-5']) {
      assert.equal(index.lookup(id)?.contextWindow, 200_000, id)
    }
    const tilde = new ModelMetaIndex([{ id: '~provider/model-1', contextWindow: 999 }])
    assert.equal(tilde.lookup('model-1')?.contextWindow, 999)
  })

  it('later registrations win for the same alias (source priority)', () => {
    const index = new ModelMetaIndex([])
    index.add({ id: 'deepseek-v4-flash', contextWindow: 100_000 })
    index.add({ id: 'deepseek-v4-flash', contextWindow: 1_000_000, maxTokens: 128_000 })
    assert.equal(index.lookup('deepseek-v4-flash')?.contextWindow, 1_000_000)
    assert.equal(index.lookup('deepseek-v4-flash')?.maxTokens, 128_000)
  })

  it('aliasesOf covers the exact id, its lowercase, and the base name', () => {
    const aliases = aliasesOf('~anthropic/claude-fable-latest')
    assert.ok(aliases.includes('~anthropic/claude-fable-latest'))
    assert.ok(aliases.includes('~anthropic/claude-fable-latest'.toLowerCase()))
    assert.ok(aliases.includes('claude-fable-latest'))
    assert.ok(aliases.includes('claude-fable-latest'.toLowerCase()))
    // A title-cased query still resolves through the lowercase alias.
    const index = new ModelMetaIndex([{ id: '~anthropic/claude-fable-latest', contextWindow: 7 }])
    assert.equal(index.lookup('Claude-Fable-Latest')?.contextWindow, 7)
  })
})

describe('size parsing (loose catalog spellings)', () => {
  it('parses suffixed context/output values like 128K and 1M', () => {
    const entry = normalizeEntry({
      id: 'loose', limit: { context: '128K', output: '1M' },
    })
    assert.equal(entry?.contextWindow, 131_072)
    assert.equal(entry?.maxTokens, 1_048_576)
  })

  it('parses plain string integers and lowercased suffixes', () => {
    const entry = normalizeEntry({
      id: 's', limit: { context: '8192', output: '256k' },
    })
    assert.equal(entry?.contextWindow, 8192)
    assert.equal(entry?.maxTokens, 262_144)
  })

  it('drops entries whose capacities are unparseable', () => {
    assert.equal(normalizeEntry({ id: 'x', limit: { context: 'lots', output: 'n/a' } }), undefined)
  })

  it('accepts models.dev boolean reasoning', () => {
    const entry = normalizeEntry({ id: 'r', reasoning: true, limit: { context: 1, output: 1 } })
    assert.equal(entry?.reasoning, true)
  })
})

describe('collectEntries (models.dev shape)', () => {
  it('walks a { slug: { models: { id: record } } } payload', () => {
    const entries = collectEntries({
      'hpc-ai': {
        id: 'hpc-ai', api: 'openai', models: {
          'deepseek/deepseek-v4-flash': {
            id: 'deepseek/deepseek-v4-flash',
            name: 'DeepSeek V4 Flash',
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 1_048_576, output: 128_000 },
          },
        },
      },
      openrouter: {
        id: 'openrouter', api: 'openai', models: {
          'openai/gpt-5.2-pro': {
            id: 'openai/gpt-5.2-pro',
            name: 'GPT-5.2 Pro',
            limit: { context: 400_000, output: 128_000 },
          },
        },
      },
    })
    assert.equal(entries.length, 2)
    // prefixed ids keep their own id; input maps text/image through modalities
    const dsv4 = entries.find((e) => e.id === 'deepseek/deepseek-v4-flash')
    assert.equal(dsv4?.contextWindow, 1_048_576)
    assert.deepEqual(dsv4?.input, ['text'])
    assert.ok(entries.some((e) => e.id === 'openai/gpt-5.2-pro'))
  })
})

describe('reasoning options parsing', () => {
  it('collects effort ladders in order and ignores toggles', () => {
    assert.deepEqual(parseReasoningOptions([{ type: 'effort', values: ['low', 'medium', 'high'] }]), ['low', 'medium', 'high'])
    assert.deepEqual(parseReasoningOptions([{ type: 'toggle' }]), undefined)
    assert.deepEqual(parseReasoningOptions([{ type: 'effort', values: ['none', 'low'] }, { type: 'effort', values: ['low', 'high'] }]), ['none', 'low', 'high'])
    assert.deepEqual(parseReasoningOptions(undefined), undefined)
    assert.deepEqual(parseReasoningOptions('x'), undefined)
  })

  it('normalizeEntry carries reasoningLevels and the reasoning flag', () => {
    const entry = normalizeEntry({
      id: 'm', limit: { context: 10, output: 10 }, reasoning: true,
      reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
    })
    assert.equal(entry?.reasoning, true)
    assert.deepEqual(entry?.reasoningLevels, ['low', 'high'])
  })

  it('the index serves reasoningLevels', () => {
    const index = new ModelMetaIndex([{ id: 'm', contextWindow: 1, reasoning: true, reasoningLevels: ['high', 'max'] }])
    assert.deepEqual(index.lookup('m')?.reasoningLevels, ['high', 'max'])
  })
})

describe('vendor attribution (models.dev)', () => {
  it('strict makers claim unprefixed ids; hosting slugs need a prefix match', () => {
    const entries = collectEntries({
      openai: { id: 'openai', models: { 'gpt-5.2': { id: 'gpt-5.2', limit: { context: 400000, output: 128000 } } } },
      'alibaba-cn': { id: 'alibaba-cn', models: { 'MiniMax-M2.5': { id: 'MiniMax-M2.5', limit: { context: 204800, output: 131072 } } } },
      minimax: { id: 'minimax', models: { 'MiniMax-M2.5': { id: 'MiniMax-M2.5', limit: { context: 204800, output: 131072 } } } },
      nvidia: { id: 'nvidia', models: { 'deepseek-ai/deepseek-v4-flash': { id: 'deepseek-ai/deepseek-v4-flash', limit: { context: 1048576, output: 128000 } } } },
      deepseek: { id: 'deepseek', models: { 'deepseek/deepseek-v4-flash': { id: 'deepseek/deepseek-v4-flash', limit: { context: 1048576, output: 128000 } } } },
    })
    const byId = (id: string) => entries.find((e) => e.id === id)
    assert.equal(byId('gpt-5.2')?.vendor, 'OpenAI')
    // alibaba-cn hosts MiniMax's model unprefixed — no vendor claim
    const hosted = entries.filter((e) => e.id === 'MiniMax-M2.5')
    assert.equal(hosted.length, 2)
    assert.ok(hosted.some((e) => e.vendor === undefined))
    assert.ok(hosted.some((e) => e.vendor === 'MiniMax'))
    // nvidia hosts deepseek's model — no Nvidia claim; the maker listing carries DeepSeek
    assert.equal(byId('deepseek-ai/deepseek-v4-flash')?.vendor, undefined)
    assert.equal(byId('deepseek/deepseek-v4-flash')?.vendor, 'DeepSeek')
  })

  it('dedupes case-variant spellings into one bucket', () => {
    const deduped = dedupeSizedEntries([
      { id: 'hf:moonshotai/Kimi-K3', contextWindow: 524288, maxTokens: 65536 },
      { id: 'kimi-k3', contextWindow: 1048576, maxTokens: 131072, vendor: 'Moonshot AI' },
    ])
    assert.equal(deduped.length, 1)
    assert.equal(deduped[0]?.vendor, 'Moonshot AI')
    assert.equal(deduped[0]?.contextWindow, 1048576)
  })

  it('dedupe prefers the maker-attributed entry', () => {
    const deduped = dedupeSizedEntries([
      { id: 'deepseek-ai/deepseek-v4-flash', contextWindow: 1048576, maxTokens: 128000 },
      { id: 'deepseek/deepseek-v4-flash', contextWindow: 1048576, maxTokens: 128000, vendor: 'DeepSeek' },
    ])
    assert.equal(deduped.length, 1)
    assert.equal(deduped[0]?.vendor, 'DeepSeek')
  })

  it('the lookup index serves vendor', () => {
    const index = new ModelMetaIndex([{ id: 'gpt-5.2', contextWindow: 400000, vendor: 'OpenAI' }])
    assert.equal(index.lookup('gpt-5.2')?.vendor, 'OpenAI')
  })
})

describe('dedupeSizedEntries', () => {
  it('keeps the most complete entry per base id', () => {
    const deduped = dedupeSizedEntries([
      { id: 'deepseek-v4-flash', contextWindow: 100_000 },
      { id: 'provider-a/deepseek-v4-flash', contextWindow: 1_048_576, maxTokens: 128_000, name: 'DeepSeek V4 Flash' },
      { id: 'BAAI/bge-m3' },
    ])
    assert.equal(deduped.length, 2)
    const best = deduped.find((e) => e.id.includes('deepseek-v4-flash'))
    assert.equal(best?.maxTokens, 128_000)
  })
})
