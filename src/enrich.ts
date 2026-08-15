/**
 * Enrichment core: decides what metadata a configured provider model is
 * missing, fills it from the PublicProviderConf lookup index, and shapes the
 * result into a sparse `llm-pi-ai` settings patch.
 *
 * Rules (all deliberate):
 *
 * - Only *missing* fields are filled. A contextWindow, maxTokens, name, or
 *   input the operator already set is never overwritten.
 * - The patch is sparse over the provider dict, but a changed `models` list
 *   is restated wholesale: the settings merge replaces arrays, so a partial
 *   list would silently drop the models it does not mention. Restatements are
 *   cleaned (schema-materialized `input: []` noise and `undefined` dropped)
 *   so the user document stays readable.
 * - `modelOverrides` entries merge per key, so only changed entries are
 *   included.
 * - Providers are only touched when they already exist in the user's own
 *   section (when the caller can say so) — composition-base-only providers
 *   are never materialized into the user document.
 *
 * @module dsh-model-meta-autofill/enrich
 */

import { deepEqualJson } from '@deepseek-ai/dsh-settings'
import type { LookedUpEntry } from './dataset.ts'

/** The llm-pi-ai model profile fields this plugin may fill. */
export type FillableFields = 'name' | 'contextWindow' | 'maxTokens' | 'input'

/** Toggles for one enrichment pass. */
export interface EnrichOptions {
  /** Fill the display name from the catalog. */
  fillName: boolean
  /** Fill input modalities (adds 'image' for vision-capable models). */
  fillInput: boolean
}

/** Default options: everything the plugin ships enabled. */
export const DEFAULT_ENRICH_OPTIONS: EnrichOptions = { fillName: true, fillInput: true }

/**
 * One model entry's metadata fields (structural, version-tolerant). A
 * `models` list entry additionally carries an `id`; a `modelOverrides`
 * value does not (its id lives in the dict key).
 */
export interface ModelHead {
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: unknown
  reasoningEfforts?: unknown
  compat?: unknown
}

/** One `models` list entry of an llm-pi-ai provider profile. */
export interface ModelEntry extends ModelHead {
  id: string
}

/** One `modelOverrides` value (no id — the dict key names the model). */
export type ModelOverrideEntry = ModelHead

/** One llm-pi-ai provider profile (structural). */
export interface ProviderProfile {
  models?: ModelEntry[]
  modelOverrides?: Record<string, ModelOverrideEntry>
  [key: string]: unknown
}

/** The llm-pi-ai settings section this plugin targets. */
export interface LlmPiAiSection {
  providers?: Record<string, ProviderProfile>
}

/**
 * Fields a restatement preserves as configured. Unknown extra fields are
 * dropped by design: the schema is strict about what a model entry may carry,
 * and preserving what we do not understand risks persisting values that
 * already violated (and would keep violating) the schema.
 */
const PRESERVED_FIELDS: readonly (keyof ModelHead)[] = [
  'name',
  'contextWindow',
  'maxTokens',
  'input',
  'reasoningEfforts',
  'compat',
]

/**
 * A clean, JSON-friendly copy of one entry's metadata: only
 * schema-meaningful fields, with `undefined` and schema-materialized
 * `input: []` noise stripped. No `id` — the caller decides whether the
 * target entry carries one.
 */
export function cleanHead(head: ModelHead): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of PRESERVED_FIELDS) {
    const value = head[field]
    if (value === undefined) continue
    if (field === 'input' && Array.isArray(value) && value.length === 0) continue
    // Detach nested data (reasoningEfforts/compat dicts may be frozen shares).
    out[field] = Array.isArray(value) ? [...value] : (typeof value === 'object' && value !== null
      ? { ...(value as Record<string, unknown>) }
      : value)
  }
  return out
}

/** A clean restatement of one `models` list entry. */
export function cleanEntry(entry: ModelEntry): Record<string, unknown> {
  return { id: entry.id, ...cleanHead(entry) }
}

/**
 * Compute the fills one catalog hit contributes for one entry, honoring the
 * toggles and never overwriting a configured value. Returns undefined when
 * nothing new can be filled.
 */
export function fillsFor(
  entry: ModelHead,
  meta: LookedUpEntry | undefined,
  options: EnrichOptions,
): Partial<Record<FillableFields, unknown>> | undefined {
  if (meta === undefined) return undefined
  const fills: Partial<Record<FillableFields, unknown>> = {}
  if (options.fillName && entry.name === undefined && meta.name !== undefined) {
    fills.name = meta.name
  }
  if (entry.contextWindow === undefined && meta.contextWindow !== undefined) {
    fills.contextWindow = meta.contextWindow
  }
  if (entry.maxTokens === undefined && meta.maxTokens !== undefined) {
    fills.maxTokens = meta.maxTokens
  }
  if (options.fillInput && (entry.input === undefined || (Array.isArray(entry.input) && entry.input.length === 0))
    && meta.input !== undefined) {
    fills.input = [...meta.input]
  }
  return Object.keys(fills).length > 0 ? fills : undefined
}

/**
 * Enrich one override entry (no id in the output). Returns the next entry or
 * undefined when nothing changed.
 */
export function enrichEntry(
  entry: ModelHead,
  meta: LookedUpEntry | undefined,
  options: EnrichOptions,
): Record<string, unknown> | undefined {
  const fills = fillsFor(entry, meta, options)
  if (fills === undefined) return undefined
  const next = { ...cleanHead(entry), ...fills }
  return deepEqualJson(next, cleanHead(entry)) ? undefined : next
}

/**
 * Enrich one `models` list entry (id preserved). Returns the next entry or
 * undefined when nothing changed.
 */
export function enrichListEntry(
  entry: ModelEntry,
  meta: LookedUpEntry | undefined,
  options: EnrichOptions,
): Record<string, unknown> | undefined {
  const fills = fillsFor(entry, meta, options)
  if (fills === undefined) return undefined
  const next = { ...cleanEntry(entry), ...fills }
  return deepEqualJson(next, cleanEntry(entry)) ? undefined : next
}

/** Whether an entry still misses metadata this pass could fill. */
export function entryNeedsFill(entry: ModelHead, meta: LookedUpEntry | undefined, options: EnrichOptions): boolean {
  return fillsFor(entry, meta, options) !== undefined
}

/**
 * Build the enrichment patch for the whole section. Returns a plain-object
 * sparse patch suitable for `ctx.settings.update(TARGET_NAMESPACE, patch)`,
 * or undefined when nothing is missing.
 *
 * @param section - the resolved `llm-pi-ai` section.
 * @param lookup - model metadata lookup (id → catalog entry).
 * @param options - fill toggles.
 * @param userProviderIds - provider routes present in the user's own settings
 *   layer; providers outside it are left alone. undefined = touch every route.
 *   An empty set touches none.
 */
export function buildSectionPatch(
  section: LlmPiAiSection | undefined,
  lookup: (id: string) => LookedUpEntry | undefined,
  options: EnrichOptions,
  userProviderIds?: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (section === undefined) return undefined
  const providers = section.providers
  if (providers === undefined) return undefined
  const providersPatch: Record<string, unknown> = {}
  let anyChange = false
  for (const [provider, profile] of Object.entries(providers)) {
    if (userProviderIds !== undefined && !userProviderIds.has(provider)) continue
    if (profile === null || typeof profile !== 'object') continue
    const profilePatch: Record<string, unknown> = {}
    // modelOverrides merge per key — only changed entries are included.
    const overrides = profile.modelOverrides
    if (overrides !== undefined) {
      const overridesPatch: Record<string, unknown> = {}
      for (const [id, entry] of Object.entries(overrides)) {
        if (entry === null || typeof entry !== 'object') continue
        const next = enrichEntry(entry as ModelOverrideEntry, lookup(id), options)
        if (next !== undefined) {
          overridesPatch[id] = next
          anyChange = true
        }
      }
      if (Object.keys(overridesPatch).length > 0) profilePatch.modelOverrides = overridesPatch
    }
    // A changed models list is restated wholesale (array replace semantics).
    const models = profile.models
    if (Array.isArray(models)) {
      let changed = false
      const nextList: Record<string, unknown>[] = []
      for (const entry of models) {
        if (entry === null || typeof entry !== 'object') {
          nextList.push(entry as Record<string, unknown>)
          continue
        }
        const model = entry as ModelEntry
        const next = enrichListEntry(model, lookup(model.id), options)
        if (next !== undefined) {
          changed = true
          nextList.push(next)
        } else {
          nextList.push(cleanEntry(model))
        }
      }
      if (changed) {
        profilePatch.models = nextList
        anyChange = true
      }
    }
    if (Object.keys(profilePatch).length > 0) providersPatch[provider] = profilePatch
  }
  return anyChange ? { providers: providersPatch } : undefined
}

/** Describe which configured models still miss fillable metadata (for logs/dry-run). */
export function listMissing(
  section: LlmPiAiSection | undefined,
  lookup: (id: string) => LookedUpEntry | undefined,
  options: EnrichOptions,
  userProviderIds?: ReadonlySet<string>,
): { provider: string; id: string; fields: string[] }[] {
  if (section === undefined) return []
  const providers = section.providers
  if (providers === undefined) return []
  const missing: { provider: string; id: string; fields: string[] }[] = []
  for (const [provider, profile] of Object.entries(providers)) {
    if (userProviderIds !== undefined && !userProviderIds.has(provider)) continue
    if (profile === null || typeof profile !== 'object') continue
    for (const entry of profile.models ?? []) {
      if (entry === null || typeof entry !== 'object') continue
      const model = entry as ModelEntry
      const fills = fillsFor(model, lookup(model.id), options)
      if (fills === undefined) continue
      missing.push({ provider, id: model.id, fields: Object.keys(fills) })
    }
    for (const [id, entry] of Object.entries(profile.modelOverrides ?? {})) {
      if (entry === null || typeof entry !== 'object') continue
      const fills = fillsFor(entry as ModelOverrideEntry, lookup(id), options)
      if (fills === undefined) continue
      missing.push({ provider, id, fields: Object.keys(fills) })
    }
  }
  return missing
}
