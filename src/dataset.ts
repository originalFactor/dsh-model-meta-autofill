/**
 * PublicProviderConf dataset adapter: loads the bundled offline snapshots,
 * optionally refreshes them over the network, and builds a model-id lookup
 * index the enrichment pass consumes.
 *
 * Data model follows the normalized snapshots produced by
 * `scripts/generate-snapshot.mjs` from
 * https://github.com/ThinkInAIXYZ/PublicProviderConf (dist/{source}.json).
 *
 * @module dsh-model-meta-autofill/dataset
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One normalized catalog model entry (the fields this plugin consumes). */
export interface CatalogEntry {
  /** Model id the provider endpoint accepts. */
  id: string
  /** Human-readable display name, when the catalog carries a prettier one. */
  name?: string
  /** Maximum combined request+response context in tokens. */
  contextWindow?: number
  /** Maximum output tokens. */
  maxTokens?: number
  /** Accepted request modalities, mapped to pi-ai's 'text'|'image'. */
  input?: readonly ('text' | 'image')[]
  /** Catalog-declared reasoning capability (advisory). */
  reasoning?: boolean
  /** Catalog-declared vision capability (advisory). */
  vision?: boolean
  /** The model's making-vendor label, when the catalog names one (models.dev). */
  vendor?: string
}

/**
 * models.dev top-level provider slugs that ARE model makers, with the display
 * label a filled display name carries ("OpenAI: GPT-5.2 Pro") and the id
 * prefixes that mark a listing as the maker's own. Makers also HOST other
 * makers' models (nvidia serves deepseek, openrouter-style reselling), so a
 * listing under a maker slug only counts as that maker's when its id is
 * unprefixed or carries one of the maker's own prefixes.
 */
export const OFFICIAL_VENDORS: Readonly<Record<string, { label: string; prefixes: readonly string[]; strict?: boolean }>> = {
  // strict: the listing holds only the maker's own models, so an unprefixed
  // id already identifies the maker. Non-strict slugs also host other makers'
  // models (alibaba-cn serves MiniMax/GLM/Kimi), where only a matching prefix
  // proves the maker.
  openai: { label: 'OpenAI', prefixes: ['openai'], strict: true },
  anthropic: { label: 'Anthropic', prefixes: ['anthropic'], strict: true },
  google: { label: 'Google', prefixes: ['google'], strict: true },
  deepseek: { label: 'DeepSeek', prefixes: ['deepseek'], strict: true },
  xai: { label: 'xAI', prefixes: ['x-ai', 'xai'], strict: true },
  moonshotai: { label: 'Moonshot AI', prefixes: ['moonshotai', 'moonshot'], strict: true },
  alibaba: { label: 'Qwen', prefixes: ['qwen', 'alibaba'], strict: true },
  'alibaba-cn': { label: 'Qwen', prefixes: ['qwen', 'alibaba'] },
  zai: { label: 'Z.ai', prefixes: ['zai'], strict: true },
  minimax: { label: 'MiniMax', prefixes: ['minimax'], strict: true },
  meta: { label: 'Meta', prefixes: ['meta', 'llama'], strict: true },
  mistral: { label: 'Mistral', prefixes: ['mistral'], strict: true },
  nvidia: { label: 'Nvidia', prefixes: ['nvidia'] },
  amazon: { label: 'Amazon', prefixes: ['amazon', 'nova'], strict: true },
}

/** What the lookup index answers with. */
export type LookedUpEntry = Omit<CatalogEntry, 'vision'>

/** One normalized snapshot file on disk. */
export interface Snapshot {
  source: string
  url: string
  fetchedAt: string
  modelCount: number
  models: CatalogEntry[]
}

/** A positive integer from an unknown JSON value, or undefined. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * Token count from a catalog's capacity field: a positive integer, or a
 * suffixed string ("128K", "1M", "256k", "8GB") with binary-based multiples.
 * Covers the loose spellings real aggregators ship — plain integers on one
 * row, "128K"/"1M" on the next. Returns undefined when unparseable/absent.
 */
function parseSizeTokens(value: unknown): number | undefined {
  const direct = positiveInt(value)
  if (direct !== undefined) return direct
  if (typeof value !== 'string') return undefined
  const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt])?b?$/i)
  if (match === null) return undefined
  const number = Number(match[1])
  if (!Number.isFinite(number) || number <= 0) return undefined
  const suffix = (match[2] ?? '').toLowerCase()
  const multiplier = suffix === '' ? 1 : suffix === 'k' ? 1024 : suffix === 'm' ? 1024 ** 2 : suffix === 'g' ? 1024 ** 3 : 1024 ** 4
  return Math.round(number * multiplier)
}

/** The first non-empty string among candidates, or undefined. */
function firstLabel(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Map a raw catalog entry's declared input modalities onto the two request
 * modalities pi-ai models accept ('text'|'image'). audio/video/pdf are
 * dropped (pi-ai cannot represent them); text is the floor. Only a catalog
 * that positively declares modalities (or vision) produces an `input` — an
 * empty declaration stays "no answer", so the route default applies.
 */
function mapInput(raw: Record<string, unknown>): readonly ('text' | 'image')[] | undefined {
  const modalities = raw.modalities
  const declared: unknown[] = Array.isArray(modalities)
    ? modalities
    : Array.isArray((modalities as { input?: unknown } | null | undefined)?.input)
      ? ((modalities as { input: unknown[] }).input)
      : []
  const vision = (raw as { vision?: unknown }).vision === true
  if (declared.length === 0 && !vision) return undefined
  // A model that accepts anything accepts text (the protocol floor), so once
  // input is decided, text is always present.
  const input: ('text' | 'image')[] = ['text']
  if (declared.includes('image') || vision) input.push('image')
  return input.length > 0 ? input : undefined
}

/**
 * Normalize one raw dist model entry into a {@link CatalogEntry}. Entries
 * carrying neither a context nor an output cap are dropped: a model the
 * catalog cannot size is not something this plugin should guess at.
 */
export function normalizeEntry(raw: unknown): CatalogEntry | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const record = raw as Record<string, unknown>
  const id = firstLabel(record.id) ?? firstLabel(record.name, record.display_name)
  if (id === undefined) return undefined
  const limit = record.limit as Record<string, unknown> | null | undefined
  const contextWindow = parseSizeTokens(limit?.context)
  const maxTokens = parseSizeTokens(limit?.output)
  if (contextWindow === undefined && maxTokens === undefined) return undefined
  const entry: CatalogEntry = { id }
  const vendor = firstLabel(record.vendor)
  if (vendor !== undefined) entry.vendor = vendor
  const name = firstLabel(record.name, record.display_name)
  if (name !== undefined && name !== id) entry.name = name
  if (contextWindow !== undefined) entry.contextWindow = contextWindow
  if (maxTokens !== undefined) entry.maxTokens = maxTokens
  const input = mapInput(record)
  if (input !== undefined) entry.input = input
  // PPC spells reasoning as { supported: true }; models.dev as a bare boolean.
  const reasoning = record.reasoning as { supported?: unknown } | boolean | null | undefined
  if (reasoning === true || typeof reasoning === 'object' && reasoning?.supported === true) entry.reasoning = true
  if (record.vision === true) entry.vision = true
  return entry
}

/** All normalized model entries of one raw dist payload (list or all.json shape). */
export function collectEntries(payload: unknown): CatalogEntry[] {
  if (payload === null || typeof payload !== 'object') return []
  const record = payload as Record<string, unknown>
  const entries: CatalogEntry[] = []
  const push = (raw: unknown): void => {
    const entry = normalizeEntry(raw)
    if (entry !== undefined) entries.push(entry)
  }
  if (Array.isArray(record.models)) {
    for (const raw of record.models) push(raw)
  }
  const providers = record.providers
  if (providers !== null && typeof providers === 'object') {
    for (const provider of Object.values(providers as Record<string, unknown>)) {
      if (provider === null || typeof provider !== 'object') continue
      const models = (provider as Record<string, unknown>).models
      if (!Array.isArray(models)) continue
      for (const raw of models) push(raw)
    }
  }
  // models.dev api.json: { slug: { id, api, models: { modelId: record } } }.
  if (providers === undefined && !Array.isArray(record.models)) {
    for (const [slug, provider] of Object.entries(record)) {
      if (provider === null || typeof provider !== 'object') continue
      const models = (provider as Record<string, unknown>).models
      if (models === null || typeof models !== 'object' || Array.isArray(models)) continue
      const official = OFFICIAL_VENDORS[slug]
      for (const [modelId, raw] of Object.entries(models as Record<string, unknown>)) {
        if (raw === null || typeof raw !== 'object') continue
        const candidate = raw as Record<string, unknown>
        const id = firstLabel(candidate.id) ?? modelId
        let vendor: string | undefined
        if (official !== undefined) {
          const slashAt = id.indexOf('/')
          const prefix = slashAt > 0 ? id.slice(0, slashAt).toLowerCase() : ''
          const prefixed = prefix !== '' && official.prefixes.some((p) => prefix === p || prefix.startsWith(p))
          if (prefixed || (official.strict === true && prefix === '')) {
            vendor = official.label
          }
        }
        push({ ...candidate, id, ...vendor === undefined ? {} : { vendor } })
      }
    }
  }
  return entries
}

/**
 * Runtime model-metadata lookup index. Registration is id-first with
 * progressively looser aliases all pointing at one entry, so a gateway that
 * serves prefixes (`anthropic/claude-sonnet-4-5`, `~provider/model`) or a
 * differently-cased id still resolves. Later registrations for the same alias
 * win (merge order implements source priority).
 */
export class ModelMetaIndex {
  private readonly byId = new Map<string, LookedUpEntry>()

  constructor(entries: Iterable<CatalogEntry | LookedUpEntry>) {
    for (const entry of entries) this.add(entry)
  }

  /** Register one entry under its id and every alias that still resolves to it. */
  add(entry: CatalogEntry | LookedUpEntry): this {
    const value: LookedUpEntry = {
      id: entry.id,
      ...entry.name === undefined ? {} : { name: entry.name },
      ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
      ...entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens },
      ...entry.input === undefined ? {} : { input: [...entry.input] },
      ...entry.reasoning === undefined ? {} : { reasoning: entry.reasoning },
      ...entry.vendor === undefined ? {} : { vendor: entry.vendor },
    }
    for (const alias of aliasesOf(entry.id)) this.byId.set(alias, value)
    this.byId.set(entry.id, value)
    return this
  }

  /** Merge every distinct entry of `other` into this index. */
  mergeFrom(other: ModelMetaIndex): this {
    if (other === this) return this
    for (const entry of other.byId.values()) this.add(entry)
    return this
  }

  /** Number of distinct model ids registered. */
  get size(): number {
    return this.byId.size
  }

  /** Look up one model id, exact first then alias-normalized. */
  lookup(id: string): LookedUpEntry | undefined {
    const direct = this.byId.get(id)
    if (direct !== undefined) return direct
    for (const alias of aliasesOf(id)) {
      const hit = this.byId.get(alias)
      if (hit !== undefined) return hit
    }
    return undefined
  }
}

/** Every lookup alias for one model id: id, lowercased, base name, lowercased base. */
export function aliasesOf(id: string): string[] {
  const aliases: string[] = []
  const push = (value: string): void => {
    if (!aliases.includes(value)) aliases.push(value)
  }
  push(id)
  push(id.toLowerCase())
  const slash = id.lastIndexOf('/')
  if (slash >= 0 && slash < id.length - 1) {
    const base = id.slice(slash + 1)
    push(base)
    push(base.toLowerCase())
    const tilde = base.indexOf('~')
    if (tilde === 0) {
      const cleaned = base.slice(1)
      push(cleaned)
      push(cleaned.toLowerCase())
    }
  } else {
    const tilde = id.indexOf('~')
    if (tilde === 0) {
      const cleaned = id.slice(1)
      push(cleaned)
      push(cleaned.toLowerCase())
    }
  }
  return aliases
}

/** Absolute path of the bundled data directory (src/data in source, lib/data in the build). */
export function dataDirectory(): string {
  return fileURLToPath(new URL('./data/', import.meta.url))
}

/** Read and parse one bundled snapshot file. */
export async function loadSnapshotFile(source: string): Promise<Snapshot> {
  const raw = await readFile(join(dataDirectory(), `${source}.json`), 'utf8')
  const snapshot = JSON.parse(raw) as Snapshot
  if (snapshot.source !== source) {
    throw new Error(`dsh-model-meta-autofill: snapshot for "${source}" carries source "${snapshot.source}"`)
  }
  return snapshot
}

/** Outcome of loading the bundled snapshots. */
export interface BundledLoadResult {
  index: ModelMetaIndex
  /** Sources that failed to load (missing/broken snapshot) — the others still serve. */
  errors: { source: string; message: string }[]
}

/** Load every bundled snapshot named by `sources`, independently per source. */
export async function loadBundledIndex(sources: readonly string[]): Promise<BundledLoadResult> {
  const index = new ModelMetaIndex([])
  const errors: { source: string; message: string }[] = []
  for (const source of sources) {
    const real = sourceId(source)
    if (real.startsWith('http')) continue
    try {
      const snapshot = await loadSnapshotFile(real)
      const before = index.size
      for (const entry of snapshot.models) index.add(entry)
      console.log(`[dsh-model-meta-autofill] bundled "${real}": ${snapshot.modelCount} models (${index.size - before} new aliases)`)
    } catch (error) {
      errors.push({ source: real, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { index, errors }
}

/** Turn a configured source into a dist-file id (URLs pass through). */
export function sourceId(source: string): string {
  const trimmed = source.trim()
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) return trimmed
  if (/^[a-z0-9][a-z0-9._-]*$/i.test(trimmed)) return trimmed
  throw new Error(`dsh-model-meta-autofill: invalid catalog source "${source}"`)
}

/** Known named sources whose live URL is not `baseUrl/<id>.json`. */
export const SOURCE_URLS: Readonly<Record<string, string>> = {
  // The Model Metadata Registry frontend — the standard per-model catalog.
  'models.dev': 'https://models.dev/api.json',
}

/** The live URL for one source id (URLs pass through unchanged). */
export function sourceUrl(id: string): string | undefined {
  return SOURCE_URLS[id]
}

/**
 * Deduplicate normalized entries: one catalog (models.dev) lists the same
 * model under many gateways. Per base id (the id a gateway actually sends,
 * prefixes stripped), keep the single most informative entry — both capacity
 * fields beat partial ones, a richer name beats a bare id, reasoning/input
 * declarations add a point, and a maker-vendor label (an official listing)
 * outranks a gateway's reselling of the same capacities — breaking remaining
 * ties by first occurrence. The chosen entry's own id is kept; aliases still
 * cover every spelling it appeared as.
 */
export function dedupeSizedEntries(entries: Iterable<CatalogEntry>): CatalogEntry[] {
  const best = new Map<string, CatalogEntry>()
  const rank = (entry: CatalogEntry): number => {
    let score = 0
    if (entry.contextWindow !== undefined) score += 10
    if (entry.maxTokens !== undefined) score += 10
    if (entry.name !== undefined) score += 1
    if (entry.reasoning === true) score += 1
    if (entry.input !== undefined && entry.input.length > 0) score += 1
    // Maker attribution outweighs richness differences: a gateway listing may
    // carry reasoning/input flags the maker's own entry omits, yet the maker
    // is still the source a display name should be credited to.
    if (entry.vendor !== undefined) score += 5
    return score
  }
  for (const entry of entries) {
    // Lowercased: 'Kimi-K3' and 'kimi-k3' are one model, whatever the casing.
    const key = (aliasesOf(entry.id).find((alias) => !alias.includes('/') && !alias.startsWith('~')) ?? entry.id).toLowerCase()
    const current = best.get(key)
    if (current === undefined || rank(entry) > rank(current)) best.set(key, entry)
  }
  return [...best.values()]
}

/** Merge one raw dist payload into an index (live data wins over bundled). */
export function mergePayload(index: ModelMetaIndex, payload: unknown): number {
  const entries = collectEntries(payload)
  let added = 0
  for (const entry of entries) {
    const before = index.size
    index.add(entry)
    if (index.size > before) added += 1
  }
  return added
}

/** One catalog the live refresh failed to fetch (kept for diagnostics). */
export interface RefreshResult {
  ok: boolean
  refreshed: string[]
  errors: { source: string; message: string }[]
  mergedAliases: number
}

/**
 * Fetch the configured PublicProviderConf dist catalogs and merge them over
 * the bundled index. Each source is attempted independently: a network or
 * parse failure keeps the offline snapshot serving and is reported, never
 * fatal.
 */
export async function refreshLive(
  index: ModelMetaIndex,
  sources: readonly string[],
  baseUrl: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<RefreshResult> {
  const result: RefreshResult = { ok: true, refreshed: [], errors: [], mergedAliases: 0 }
  for (const source of sources) {
    const id = sourceId(source)
    const url = id.startsWith('http') ? id : (sourceUrl(id) ?? `${baseUrl.replace(/\/+$/, '')}/${id}.json`)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)
      let response: Response
      try {
        response = await fetch(url, {
          headers: { accept: 'application/json' },
          signal: signal === undefined ? controller.signal : AbortSignal.any([controller.signal, signal]),
        })
      } finally {
        clearTimeout(timer)
      }
      if (!response.ok) throw new Error(`GET ${url} answered ${response.status}`)
      const payload = await response.json() as unknown
      const merged = mergePayload(index, payload)
      result.refreshed.push(id)
      result.mergedAliases += merged
    } catch (error) {
      result.ok = false
      result.errors.push({
        source: id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return result
}
