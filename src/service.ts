/**
 * The `ctx.modelMeta` host service exposed by this plugin: a small query
 * surface over the merged PublicProviderConf index and the enrichment
 * helpers, for other host plugins and configuration surfaces.
 *
 * @module dsh-model-meta-autofill/service
 */

import type { LookedUpEntry, ModelMetaIndex, RefreshResult } from './dataset.ts'
import {
  buildSectionPatch,
  DEFAULT_ENRICH_OPTIONS,
  EnrichOptions,
  LlmPiAiSection,
} from './enrich.ts'

/** Refresh diagnostics the service reports on demand. */
export interface ModelMetaStats {
  /** Number of catalog sources currently merged. */
  sourceCount: number
  /** Distinct aliases in the lookup index. */
  entryCount: number
  /** ISO timestamp of the last live refresh, when one ran. */
  lastRefreshAt?: string
  /** Last refresh outcome, when one ran. */
  lastRefresh?: RefreshResult
}

/** The host-facing service contract. */
export interface ModelMetaService {
  /** Look up one model id (exact, case-insensitive, prefix-stripped). */
  lookup(id: string): LookedUpEntry | undefined
  /** Sizes and last-refresh diagnostics. */
  stats(): ModelMetaStats
  /** Force a live refresh; resolves with the per-source outcome. */
  refresh(): Promise<RefreshResult>
  /** Build the llm-pi-ai enrichment patch for one section (pure). */
  buildSectionPatch(
    section: LlmPiAiSection | undefined,
    options?: Partial<EnrichOptions>,
    userProviderIds?: ReadonlySet<string>,
  ): Record<string, unknown> | undefined
}

/** Instantiate the service over one index (shared with the apply fiber). */
export function createModelMetaService(
  index: ModelMetaIndex,
  sources: readonly string[],
  baseUrl: string,
  timeoutMs: number,
): ModelMetaService {
  let lastRefreshAt: string | undefined
  let lastRefresh: RefreshResult | undefined
  const options = (): EnrichOptions => ({ ...DEFAULT_ENRICH_OPTIONS })
  return {
    lookup: (id) => index.lookup(id),
    stats: () => ({
      sourceCount: sources.length,
      entryCount: index.size,
      ...lastRefreshAt === undefined ? {} : { lastRefreshAt },
      ...lastRefresh === undefined ? {} : { lastRefresh },
    }),
    refresh: async () => {
      const { refreshLive } = await import('./dataset.ts')
      const result = await refreshLive(index, sources, baseUrl, timeoutMs)
      lastRefreshAt = new Date().toISOString()
      lastRefresh = result
      return result
    },
    buildSectionPatch: (section, optionsPatch, userProviderIds) =>
      buildSectionPatch(section, (id) => index.lookup(id), { ...options(), ...optionsPatch }, userProviderIds),
  }
}

/** Type augmentation: expose `ctx.modelMeta`. */
declare module '@deepseek-ai/cordis' {
  interface Context {
    /** PublicProviderConf-backed model metadata lookup and enrichment. */
    modelMeta: ModelMetaService
  }
}
