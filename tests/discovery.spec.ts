/**
 * Unit tests for the discovery seam and the candidate enrichment.
 *
 * These cover the seam's own contract without booting a profile: what the wrap
 * observes, what it leaves alone, and what it restores.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LlmDiscoveredModel, LlmModelDiscoveryRequest } from '@deepseek-ai/dsh-llm'
import { installDiscoveryEnrichment, type DiscoveryHost } from '../src/discovery.ts'
import { enrichDiscovered, type DiscoveredModel } from '../src/enrich.ts'

const OPTS = { fillName: true, fillInput: true }

const meta: Record<string, { id: string; name: string; contextWindow: number; maxTokens: number; input: ('text' | 'image')[] }> = {
  known: { id: 'known', name: 'Known Model', contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'] },
  vision: { id: 'vision', name: 'Vision Model', contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'] },
}
const lookup = (id: string) => meta[id]

describe('enrichDiscovered', () => {
  it('fills the fields discovery left open', () => {
    assert.deepEqual(enrichDiscovered([{ id: 'known' }], lookup, OPTS), [{
      id: 'known',
      name: 'Known Model',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      inputModalities: ['text'],
    }])
  })

  it('keeps every value the endpoint disclosed', () => {
    // The endpoint's own numbers win; only gaps are filled.
    const [only] = enrichDiscovered(
      [{ id: 'known', contextWindow: 65_536, name: 'Gateway Label' }],
      lookup,
      OPTS,
    )
    assert.equal(only?.['contextWindow'], 65_536)
    assert.equal(only?.['name'], 'Gateway Label')
    assert.equal(only?.['maxTokens'], 384_000, 'the open field is still filled')
  })

  it('keeps disclosed input modalities rather than replacing them', () => {
    const [only] = enrichDiscovered([{ id: 'known', inputModalities: ['text', 'image'] }], lookup, OPTS)
    assert.deepEqual(only?.['inputModalities'], ['text', 'image'])
  })

  it('returns a model the catalog does not know byte-identical', () => {
    const candidate: DiscoveredModel = { id: 'unknown', contextWindow: 4096 }
    assert.deepEqual(enrichDiscovered([candidate], lookup, OPTS), [candidate])
  })

  it('replaces a name that merely repeats the model id', () => {
    // Many gateways list a model's id AS its display name. Treating that as a
    // disclosed name would preserve the placeholder and hide the catalog's
    // readable one — the live page showed this as a bare-id title.
    const [only] = enrichDiscovered([{ id: 'known', name: 'known' }], lookup, OPTS)
    assert.equal(only?.['name'], 'Known Model')
  })

  it('treats an id-as-name placeholder case- and space-insensitively', () => {
    const [only] = enrichDiscovered([{ id: 'known', name: '  KNOWN  ' }], lookup, OPTS)
    assert.equal(only?.['name'], 'Known Model')
  })

  it('still keeps a real name that differs from the id', () => {
    const [only] = enrichDiscovered([{ id: 'known', name: 'known-2' }], lookup, OPTS)
    assert.equal(only?.['name'], 'known-2')
  })

  it('adds no model the endpoint did not advertise', () => {
    // The catalog knows more models than the endpoint serves; none may appear.
    const found = enrichDiscovered([{ id: 'known' }], lookup, OPTS)
    assert.deepEqual(found.map((model) => model.id), ['known'])
  })

  it('preserves order and returns every candidate', () => {
    const found = enrichDiscovered([{ id: 'unknown' }, { id: 'vision' }, { id: 'known' }], lookup, OPTS)
    assert.deepEqual(found.map((model) => model.id), ['unknown', 'vision', 'known'])
  })

  it('honors the fill toggles', () => {
    const [only] = enrichDiscovered([{ id: 'known' }], lookup, { fillName: false, fillInput: false })
    assert.equal(only?.['name'], undefined, 'name filling is off')
    assert.equal(only?.['inputModalities'], undefined, 'input filling is off')
    assert.equal(only?.['contextWindow'], 1_000_000, 'capacities are not governed by those toggles')
  })

  it('answers an empty list for an endpoint that disclosed nothing', () => {
    assert.deepEqual(enrichDiscovered([], lookup, OPTS), [])
  })
})

/** A host whose method sits on the prototype, as the real service's does. */
class PrototypeHost implements DiscoveryHost {
  readonly calls: string[] = []
  candidates: LlmDiscoveredModel[] = []
  async discoverModels(settingsNs: string, _request: LlmModelDiscoveryRequest): Promise<LlmDiscoveredModel[]> {
    this.calls.push(settingsNs)
    return [...this.candidates]
  }
}

describe('installDiscoveryEnrichment', () => {
  const describeWith = (candidates: readonly LlmDiscoveredModel[]): readonly LlmDiscoveredModel[] =>
    enrichDiscovered(candidates, lookup, OPTS)

  it('describes the candidates of the named namespace', async () => {
    const host = new PrototypeHost()
    host.candidates = [{ id: 'known' }]
    const dispose = installDiscoveryEnrichment(host, { settingsNs: 'llm-pi-ai', describe: async (c) => describeWith(c) })

    const found = await host.discoverModels('llm-pi-ai', { baseURL: 'https://gw.example/v1' })
    assert.equal(found[0]?.['contextWindow'], 1_000_000)
    dispose()
  })

  it('leaves another namespace untouched and does not even describe it', async () => {
    const host = new PrototypeHost()
    host.candidates = [{ id: 'known' }]
    let described = 0
    const dispose = installDiscoveryEnrichment(host, {
      settingsNs: 'llm-pi-ai',
      describe: async (c) => { described += 1; return describeWith(c) },
    })

    const found = await host.discoverModels('llm-other', { baseURL: 'https://gw.example/v1' })
    assert.deepEqual(found, [{ id: 'known' }])
    assert.equal(described, 0, 'another family is not ours to size')
    dispose()
  })

  it('asks the previous method exactly once', async () => {
    const host = new PrototypeHost()
    host.candidates = []
    const dispose = installDiscoveryEnrichment(host, { settingsNs: 'llm-pi-ai', describe: async (c) => describeWith(c) })
    await host.discoverModels('llm-pi-ai', { baseURL: 'https://gw.example/v1' })
    assert.deepEqual(host.calls, ['llm-pi-ai'])
    dispose()
  })

  it('propagates a failure from the previous method', async () => {
    const host = new PrototypeHost()
    host.discoverModels = async () => { throw new Error('listing refused') }
    const dispose = installDiscoveryEnrichment(host, { settingsNs: 'llm-pi-ai', describe: async (c) => describeWith(c) })
    await assert.rejects(
      () => host.discoverModels('llm-pi-ai', { baseURL: 'https://gw.example/v1' }),
      /listing refused/,
    )
    dispose()
  })

  it('propagates a failure from the describing pass', async () => {
    // Silently answering with undescribed rows would let a caller adopt models
    // this plugin failed to size, with nothing said.
    const host = new PrototypeHost()
    host.candidates = [{ id: 'known' }]
    const dispose = installDiscoveryEnrichment(host, {
      settingsNs: 'llm-pi-ai',
      describe: async () => { throw new Error('index unavailable') },
    })
    await assert.rejects(
      () => host.discoverModels('llm-pi-ai', { baseURL: 'https://gw.example/v1' }),
      /index unavailable/,
    )
    dispose()
  })

  it('removes its shadow on disposal, restoring the prototype method', async () => {
    const host = new PrototypeHost()
    const original = host.discoverModels
    const dispose = installDiscoveryEnrichment(host, { settingsNs: 'llm-pi-ai', describe: async (c) => describeWith(c) })
    assert.notEqual(host.discoverModels, original, 'mounted: the wrap is in place')

    dispose()
    assert.equal(Object.hasOwn(host, 'discoverModels'), false, 'the owner property is gone')
    assert.equal(host.discoverModels, original, 'the prototype method serves again')
  })

  it('restores an existing own property rather than deleting it', async () => {
    // A neighbouring plugin's own wrap must survive this plugin's teardown.
    const host = new PrototypeHost()
    const neighbour = async (): Promise<LlmDiscoveredModel[]> => [{ id: 'from-neighbour' }]
    const own = Object.getOwnPropertyDescriptor(host, 'discoverModels')
    assert.equal(own, undefined)
    host.discoverModels = neighbour

    const dispose = installDiscoveryEnrichment(host, { settingsNs: 'llm-pi-ai', describe: async (c) => describeWith(c) })
    dispose()
    assert.equal(host.discoverModels, neighbour, 'the neighbour wrap is restored')
  })

  it('describes nothing when the endpoint disclosed nothing', async () => {
    const host = new PrototypeHost()
    host.candidates = []
    const dispose = installDiscoveryEnrichment(host, { settingsNs: 'llm-pi-ai', describe: async (c) => describeWith(c) })
    assert.deepEqual(await host.discoverModels('llm-pi-ai', { baseURL: 'https://gw.example/v1' }), [])
    dispose()
  })
})
