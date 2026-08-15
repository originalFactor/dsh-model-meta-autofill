import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  normalizeCatalogLevel, presetLadder, presetWireValue, THINKING_FORMATS, validateEfforts,
} from '../src/reasoning.ts'

describe('reasoning presets', () => {
  it('every declared format id is accepted by pi-ai', () => {
    const ids = THINKING_FORMATS.map((f) => f.id)
    for (const id of ids) {
      assert.ok(['openai', 'deepseek', 'openrouter', 'together', 'zai', 'qwen', 'string-thinking', 'ant-ling'].includes(id), id)
    }
  })

  it('presetWireValue maps levels and keeps off null', () => {
    assert.equal(presetWireValue('openai', 'high'), 'high')
    assert.equal(presetWireValue('openai', 'off'), null)
    assert.equal(presetWireValue('qwen', 'high'), 'on')
    assert.equal(presetWireValue('openrouter', 'xhigh'), 'xhigh')
    assert.equal(presetWireValue('openrouter', 'off'), null)
  })

  it('normalizeCatalogLevel translates catalog names', () => {
    assert.equal(normalizeCatalogLevel('none'), 'off')
    assert.equal(normalizeCatalogLevel('HIGH'), 'high')
    assert.equal(normalizeCatalogLevel('turbo'), '')
  })

  it('presetLadder covers catalog ladders, toggles, and non-reasoning', () => {
    assert.deepEqual(presetLadder({ reasoning: true, reasoningLevels: ['low', 'medium', 'high'] }), ['off', 'low', 'medium', 'high'])
    assert.deepEqual(presetLadder({ reasoning: true }), ['off', 'high'])
    assert.deepEqual(presetLadder({ reasoning: false }), [])
    assert.deepEqual(presetLadder(undefined), [])
    assert.deepEqual(presetLadder({ reasoning: true, reasoningLevels: ['none', 'high'] }), ['off', 'high'])
  })
})

describe('validateEfforts', () => {
  it('accepts false and a serviceable dict', () => {
    assert.equal(validateEfforts(false), undefined)
    assert.equal(validateEfforts({ off: null, high: 'high' }), undefined)
    assert.equal(validateEfforts({ off: 'disabled', low: 'low' }), undefined)
  })

  it('rejects empty, unknown levels, and missing wire values', () => {
    assert.ok(validateEfforts({}) !== undefined)
    assert.ok((validateEfforts({ turbo: 'x' }) ?? '').includes('turbo'))
    assert.ok((validateEfforts({ high: '' }) ?? '').includes('high'))
    assert.equal(validateEfforts({ off: null, high: 'high', low: '' }) !== undefined, true)
    assert.ok(validateEfforts('nope') !== undefined)
  })
})
