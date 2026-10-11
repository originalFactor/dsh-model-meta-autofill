/**
 * The seam against the REAL LlmRuntime, not a stand-in.
 *
 * The design assumes an instance-level wrap of `discoverModels` is observed by
 * ordinary callers AND by the `@Remote` adapter (which calls `this.discoverModels`
 * internally). A fake cannot prove either. This boots the real service, registers
 * a real discovery through the documented API, and then checks what this plugin's
 * wrap sees.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { installDiscoveryEnrichment } from '../src/discovery.ts'
import { enrichDiscovered } from '../src/enrich.ts'

const OPTS = { fillName: true, fillInput: true }
const lookup = (id: string) => (id === 'deepseek-v4-flash'
  ? { id, name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxTokens: 384_000, input: ['text'] as ('text' | 'image')[] }
  : undefined)

/** Boot the real LLM service with one registered discovery. */
async function withRealRuntime(
  candidates: { id: string }[],
): Promise<{ ctx: Context; dispose: () => void }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  // Registered exactly as llm-pi-ai registers it, through the documented API.
  ctx.llm.registerModelDiscovery('llm-pi-ai', async () => candidates)
  return { ctx, dispose: () => { void ctx.fiber.dispose() } }
}

describe('the discovery seam against the real LlmRuntime', () => {
  it('describes what a caller of ctx.llm.discoverModels receives', async () => {
    const { ctx, dispose } = await withRealRuntime([{ id: 'deepseek-v4-flash' }])
    const stop = installDiscoveryEnrichment(ctx.llm, {
      settingsNs: 'llm-pi-ai',
      describe: async (found) => enrichDiscovered(found, lookup, OPTS),
    })

    const models = await ctx.llm.discoverModels('llm-pi-ai', { baseURL: 'https://gw.example/v1' })
    assert.deepEqual(models, [{
      id: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      contextWindow: 1_000_000,
      maxTokens: 384_000,
      inputModalities: ['text'],
    }])

    stop()
    dispose()
  })

  it('describes what the @Remote adapter returns', async () => {
    // This is the path the browser actually takes, and it reads the method off
    // the instance — so this is the assertion that proves the wrap is visible
    // to the Models page.
    const { ctx, dispose } = await withRealRuntime([{ id: 'deepseek-v4-flash' }])
    const stop = installDiscoveryEnrichment(ctx.llm, {
      settingsNs: 'llm-pi-ai',
      describe: async (found) => enrichDiscovered(found, lookup, OPTS),
    })

    const models = await ctx.llm.remoteDiscoverModels(
      'llm-pi-ai',
      { baseURL: 'https://gw.example/v1' },
      new AbortController().signal,
    )
    assert.equal(models[0]?.contextWindow, 1_000_000, 'the Remote path sees the described rows')
    assert.equal(models[0]?.name, 'DeepSeek V4 Flash')

    stop()
    dispose()
  })

  it('leaves the service untouched after disposal', async () => {
    const { ctx, dispose } = await withRealRuntime([{ id: 'deepseek-v4-flash' }])
    const stop = installDiscoveryEnrichment(ctx.llm, {
      settingsNs: 'llm-pi-ai',
      describe: async (found) => enrichDiscovered(found, lookup, OPTS),
    })
    stop()

    const models = await ctx.llm.discoverModels('llm-pi-ai', { baseURL: 'https://gw.example/v1' })
    assert.deepEqual(models, [{ id: 'deepseek-v4-flash' }], 'no description survives teardown')
    assert.equal(Object.hasOwn(ctx.llm, 'discoverModels'), false, 'no shadow left behind')
    dispose()
  })

  it('keeps the service validating its own preconditions through the wrap', async () => {
    // The wrap must not swallow the service's own refusals: an unknown
    // namespace still fails with NO_DISCOVERY.
    const { ctx, dispose } = await withRealRuntime([{ id: 'deepseek-v4-flash' }])
    const stop = installDiscoveryEnrichment(ctx.llm, {
      settingsNs: 'llm-pi-ai',
      describe: async (found) => enrichDiscovered(found, lookup, OPTS),
    })
    await assert.rejects(
      () => ctx.llm.discoverModels('llm-absent', { baseURL: 'https://gw.example/v1' }),
      /no model discovery is registered/,
    )
    stop()
    dispose()
  })
})
