/**
 * Host web surface for dsh-model-meta-autofill: plain HTTP endpoints the
 * plugin's own settings page (or any local caller) uses to list configured
 * models against the models.dev catalog and to switch models' metadata to the
 * catalog values. Loopback-only in practice (the web profile binds
 * 127.0.0.1); every route answers JSON.
 *
 * Routes (exact, registered on ctx.webServer with the settings service):
 *
 *   GET  /model-meta-autofill/api/status     -> { enabled, sources, entryCount }
 *   GET  /model-meta-autofill/api/models     -> { providers: [...] }
 *   POST /model-meta-autofill/api/apply      -> { ok, applied?, reason? }
 *   POST /model-meta-autofill/api/apply-all  -> { ok, filled, missed }
 *
 * @module dsh-model-meta-autofill/api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LookedUpEntry } from './dataset.ts'
import type { LlmPiAiSection } from './enrich.ts'
import { presetLadder, validateEfforts } from './reasoning.ts'

export type { LlmPiAiSection }

/** How a filled display name is written. */
export type NameStyle = 'vendor' | 'bare'

/** One model row: the configured entry plus its catalog match (if any). */
export interface ModelRowView {
  id: string
  /** Whether the catalog (models.dev) knows this id. */
  matched: boolean
  /** The catalog values, when matched. */
  catalog: Omit<LookedUpEntry, 'id'> | undefined
  /** The currently configured values. */
  configured: Partial<Record<'name' | 'contextWindow' | 'maxTokens', unknown>> & { input?: unknown }
}

/** One provider's rows as the UI lists them. */
export interface ProviderRowsView {
  provider: string
  /** Whether the route lives in the user layer (only these are writable). */
  userConfigured: boolean
  models: ModelRowView[]
}

/** The public shape of the catalog entry minus its id. */
export interface CatalogView {
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: readonly ('text' | 'image')[]
}

/**
 * Split a catalog display name into its vendor label and bare model name.
 * models.dev official listings carry clean names plus a maker vendor; gateway
 * listings sometimes bake the vendor into the name ("OpenAI/GPT-5.2") — that
 * prefix is recovered as the vendor when no explicit one is known.
 */
export function splitVendorName(
  name: string | undefined,
  vendor: string | undefined,
): { vendor?: string; bare?: string } {
  if (name === undefined) return {}
  let bare = name
  let inferred = vendor
  const slash = name.indexOf('/')
  if (slash > 0 && slash < name.length - 1) {
    const prefix = name.slice(0, slash).trim()
    const rest = name.slice(slash + 1).trim()
    if (prefix !== '' && rest !== '') {
      bare = rest
      if (inferred === undefined) inferred = prefix
    }
  }
  return { ...inferred === undefined ? {} : { vendor: inferred }, bare }
}

/** The display name a fill writes, honoring the vendor-prefix style. */
export function displayName(
  meta: { name?: string; vendor?: string },
  style: NameStyle,
): string | undefined {
  const parts = splitVendorName(meta.name, meta.vendor)
  if (parts.bare === undefined) return undefined
  if (style === 'vendor' && parts.vendor !== undefined) return `${parts.vendor}: ${parts.bare}`
  return parts.bare
}

/** One model's entry inside a provider profile (list entry or override value). */
function entryOf(profile: { models?: unknown; modelOverrides?: unknown } | undefined, modelId: string):
  | { kind: 'list'; index: number; head: Record<string, unknown> }
  | { kind: 'override'; head: Record<string, unknown> }
  | undefined {
  if (profile === undefined) return undefined
  if (Array.isArray(profile.models)) {
    const index = profile.models.findIndex((raw) => raw !== null && typeof raw === 'object' && (raw as { id?: unknown }).id === modelId)
    if (index !== -1) {
      const raw = profile.models[index]
      const head: Record<string, unknown> = {}
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (k !== 'id') head[k] = v
      }
      return { kind: 'list', index, head }
    }
  }
  const overrides = profile.modelOverrides
  if (overrides !== null && typeof overrides === 'object' && !Array.isArray(overrides)
    && Object.prototype.hasOwnProperty.call(overrides, modelId)) {
    const raw = (overrides as Record<string, unknown>)[modelId]
    const head: Record<string, unknown> = {}
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) head[k] = v
    }
    return { kind: 'override', head }
  }
  return undefined
}

/** The catalog-view fields one lookup contributes to a row. */
function catalogView(meta: LookedUpEntry | undefined): Omit<LookedUpEntry, 'id'> | undefined {
  if (meta === undefined) return undefined
  return {
    ...meta.vendor === undefined ? {} : { vendor: meta.vendor },
    ...meta.name === undefined ? {} : { name: meta.name },
    ...meta.contextWindow === undefined ? {} : { contextWindow: meta.contextWindow },
    ...meta.maxTokens === undefined ? {} : { maxTokens: meta.maxTokens },
    ...meta.input === undefined ? {} : { input: meta.input },
  }
}

/**
 * List every provider of the resolved section with per-model fill status.
 */
export function listRows(
  section: LlmPiAiSection | undefined,
  lookup: (id: string) => LookedUpEntry | undefined,
  userProviderIds?: ReadonlySet<string>,
): ProviderRowsView[] {
  if (section === undefined) return []
  const providers = section.providers
  if (providers === undefined) return []
  const rows: ProviderRowsView[] = []
  for (const [provider, profile] of Object.entries(providers)) {
    if (profile === null || typeof profile !== 'object') continue
    const userConfigured = userProviderIds === undefined || userProviderIds.has(provider)
    const models: ModelRowView[] = []
    for (const raw of profile.models ?? []) {
      if (raw === null || typeof raw !== 'object') continue
      const model = raw as unknown as Record<string, unknown>
      const id = typeof model.id === 'string' ? model.id : undefined
      if (id === undefined) continue
      const meta = lookup(id)
      models.push({
        id,
        matched: meta !== undefined,
        catalog: catalogView(meta),
        configured: {
          ...model.name === undefined ? {} : { name: model.name },
          ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
          ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
          ...model.input === undefined ? {} : { input: model.input },
        },
      })
    }
    for (const [id, raw] of Object.entries(profile.modelOverrides ?? {})) {
      if (raw === null || typeof raw !== 'object') continue
      const meta = lookup(id)
      const override = raw as Record<string, unknown>
      models.push({
        id,
        matched: meta !== undefined,
        catalog: catalogView(meta),
        configured: {
          ...override.name === undefined ? {} : { name: override.name },
          ...override.contextWindow === undefined ? {} : { contextWindow: override.contextWindow },
          ...override.maxTokens === undefined ? {} : { maxTokens: override.maxTokens },
          ...override.input === undefined ? {} : { input: override.input },
        },
      })
    }
    rows.push({ provider, userConfigured, models })
  }
  return rows
}

/**
 * Merge the catalog values into one entry head. Overwrite replaces every
 * field the catalog knows; otherwise only missing fields fill. A catalog gap
 * never erases a configured value.
 */
function mergedEntry(
  head: Record<string, unknown>,
  meta: LookedUpEntry,
  overwrite: boolean,
  nameStyle: NameStyle,
): { next: Record<string, unknown>; applied: CatalogView } {
  const next: Record<string, unknown> = { ...head }
  const applied: CatalogView = {}
  const name = displayName(meta, nameStyle)
  if (name !== undefined && (overwrite || next.name === undefined)) {
    next.name = name
    applied.name = name
  }
  if (meta.contextWindow !== undefined && (overwrite || next.contextWindow === undefined)) {
    next.contextWindow = meta.contextWindow
    applied.contextWindow = meta.contextWindow
  }
  if (meta.maxTokens !== undefined && (overwrite || next.maxTokens === undefined)) {
    next.maxTokens = meta.maxTokens
    applied.maxTokens = meta.maxTokens
  }
  if (meta.input !== undefined && (overwrite || next.input === undefined)) {
    next.input = [...meta.input]
    applied.input = [...meta.input]
  }
  return { next, applied }
}

/** One apply outcome; the caller either has a patch to write or a reason to report. */
export interface ApplyResult {
  ok: boolean
  /** Sparse section patch to persist through settings.update (only when ok). */
  patch?: Record<string, unknown>
  /** The catalog values this apply brought in. */
  applied?: CatalogView & { modelId: string; provider: string }
  reason?: string
}

/**
 * Build the patch that switches ONE model's metadata to the catalog values.
 * "Switch to" means overwrite default: each catalog field replaces the
 * configured one; a catalog missing a field keeps the configured value (never
 * erases). The changed models list is restated wholesale (array-replace
 * semantics); modelOverrides patch only the changed key.
 */
export function applyRow(
  section: LlmPiAiSection | undefined,
  lookup: (id: string) => LookedUpEntry | undefined,
  userProviderIds: ReadonlySet<string> | undefined,
  provider: string,
  modelId: string,
  overwrite = true,
  nameStyle: NameStyle = 'bare',
): ApplyResult {
  if (userProviderIds !== undefined && !userProviderIds.has(provider)) {
    return { ok: false, reason: 'provider-not-configured' }
  }
  if (section === undefined) return { ok: false, reason: 'provider-not-found' }
  const profile = section.providers?.[provider]
  if (profile === undefined) return { ok: false, reason: 'provider-not-found' }
  const meta = lookup(modelId)
  if (meta === undefined) return { ok: false, reason: 'no-match' }
  const located = entryOf(profile, modelId)
  if (located === undefined) return { ok: false, reason: 'model-not-found' }

  const { next, applied } = mergedEntry(located.head, meta, overwrite, nameStyle)
  let patch: Record<string, unknown>
  if (located.kind === 'list') {
    const rebuilt = (profile.models ?? []).map((raw) => raw as unknown as Record<string, unknown>)
    rebuilt[located.index] = { ...(rebuilt[located.index] as Record<string, unknown>), ...next }
    patch = { providers: { [provider]: { ...profile, models: rebuilt } } }
  } else {
    const overrides = { ...(profile.modelOverrides ?? {}) } as Record<string, unknown>
    overrides[modelId] = { ...(overrides[modelId] as Record<string, unknown>), ...next }
    patch = { providers: { [provider]: { modelOverrides: overrides } } }
  }
  return { ok: true, patch, applied: { ...applied, modelId, provider } }
}

/** Outcome of a bulk apply across every user-layer provider. */
export interface ApplyAllResult {
  ok: boolean
  /** One patch covering every changed provider (undefined when nothing matched). */
  patch?: Record<string, unknown>
  /** Every model the catalog answered for (values overwritten). */
  filled: { provider: string; modelId: string }[]
  /** Every configured model the catalog does not know. */
  missed: { provider: string; modelId: string }[]
}

/**
 * Build ONE patch overwriting every user-layer model's metadata with the
 * catalog values (the "全部覆盖" action). Providers outside the user layer
 * are untouched; unmatched models are reported, never guessed at.
 */
export function applyAll(
  section: LlmPiAiSection | undefined,
  lookup: (id: string) => LookedUpEntry | undefined,
  userProviderIds: ReadonlySet<string> | undefined,
  nameStyle: NameStyle = 'bare',
): ApplyAllResult {
  const filled: { provider: string; modelId: string }[] = []
  const missed: { provider: string; modelId: string }[] = []
  if (section === undefined) return { ok: true, filled, missed }
  const providers = section.providers
  if (providers === undefined) return { ok: true, filled, missed }
  const providersPatch: Record<string, unknown> = {}
  for (const [provider, profile] of Object.entries(providers)) {
    if (userProviderIds !== undefined && !userProviderIds.has(provider)) continue
    if (profile === null || typeof profile !== 'object') continue
    let changed = false
    const rebuiltModels: Record<string, unknown>[] = []
    for (const raw of profile.models ?? []) {
      if (raw === null || typeof raw !== 'object') {
        rebuiltModels.push(raw as unknown as Record<string, unknown>)
        continue
      }
      const model = raw as unknown as Record<string, unknown>
      const id = typeof model.id === 'string' ? model.id : undefined
      if (id === undefined) {
        rebuiltModels.push(model)
        continue
      }
      const meta = lookup(id)
      if (meta === undefined) {
        missed.push({ provider, modelId: id })
        rebuiltModels.push(model)
        continue
      }
      const head: Record<string, unknown> = { ...model }
      delete head.id
      const { next } = mergedEntry(head, meta, true, nameStyle)
      rebuiltModels.push({ ...model, ...next })
      changed = true
      filled.push({ provider, modelId: id })
    }
    const overridesPatch: Record<string, unknown> = {}
    for (const [id, raw] of Object.entries(profile.modelOverrides ?? {})) {
      if (raw === null || typeof raw !== 'object') continue
      const meta = lookup(id)
      if (meta === undefined) {
        missed.push({ provider, modelId: id })
        continue
      }
      const { next } = mergedEntry({ ...(raw as Record<string, unknown>) }, meta, true, nameStyle)
      overridesPatch[id] = { ...(raw as Record<string, unknown>), ...next }
      changed = true
      filled.push({ provider, modelId: id })
    }
    if (changed) {
      const profilePatch: Record<string, unknown> = { ...profile, models: rebuiltModels }
      if (Object.keys(overridesPatch).length > 0) {
        profilePatch.modelOverrides = { ...(profile.modelOverrides ?? {}), ...overridesPatch }
      }
      providersPatch[provider] = profilePatch
    }
  }
  const patch = Object.keys(providersPatch).length > 0 ? { providers: providersPatch } : undefined
  return { ok: true, ...patch === undefined ? {} : { patch }, filled, missed }
}

/* ------------------------------------------------- reasoning declaration --- */

/** One model's reasoning declaration view. */
export interface ReasoningModelView {
  id: string
  /** Whether the model is a list entry (true) or an override (false). */
  isList: boolean
  /** The configured declaration: a levels dict, false (disabled), or undefined (unset). */
  declared: Record<string, string | null> | false | undefined
  /** Whether models.dev reports the model reasons at all. */
  catalogReasoning: boolean
  /** The preset ladder for this model (off + declared effort levels). */
  preset: string[]
  /** Catalog-declared effort names (raw). */
  catalogLevels: readonly string[] | undefined
}

/** One provider's reasoning declaration view. */
export interface ReasoningProviderView {
  provider: string
  userConfigured: boolean
  /** The route's wire protocol (models use it unless they name their own). */
  api: string | undefined
  /** Route-level compat.thinkingFormat, when configured. */
  thinkingFormat: string | undefined
  models: ReasoningModelView[]
}

/** Read every user-layer provider's reasoning declarations. */
export function listReasoning(
  section: LlmPiAiSection | undefined,
  lookup: (id: string) => LookedUpEntry | undefined,
  userProviderIds?: ReadonlySet<string>,
): ReasoningProviderView[] {
  if (section === undefined) return []
  const providers = section.providers
  if (providers === undefined) return []
  const views: ReasoningProviderView[] = []
  for (const [provider, profile] of Object.entries(providers)) {
    if (userProviderIds !== undefined && !userProviderIds.has(provider)) continue
    if (profile === null || typeof profile !== 'object') continue
    const api = typeof profile.api === 'string' ? profile.api : undefined
    const thinkingFormat = typeof profile.compat === 'object' && profile.compat !== null
      ? (profile.compat as Record<string, unknown>).thinkingFormat
      : undefined
    const models: ReasoningModelView[] = []
    const pushModel = (id: string, isList: boolean, declared: unknown): void => {
      const meta = lookup(id)
      models.push({
        id,
        isList,
        declared: declared === undefined ? undefined
          : declared === false ? false
            : declared !== null && typeof declared === 'object' ? declared as Record<string, string | null>
              : undefined,
        catalogReasoning: meta?.reasoning === true,
        preset: presetLadder(meta),
        catalogLevels: meta?.reasoningLevels,
      })
    }
    for (const raw of profile.models ?? []) {
      if (raw === null || typeof raw !== 'object') continue
      const model = raw as unknown as Record<string, unknown>
      if (typeof model.id === 'string') pushModel(model.id, true, model.reasoningEfforts)
    }
    for (const [id, raw] of Object.entries(profile.modelOverrides ?? {})) {
      if (raw === null || typeof raw !== 'object') continue
      pushModel(id, false, (raw as Record<string, unknown>).reasoningEfforts)
    }
    views.push({ provider, userConfigured: true, api, thinkingFormat: typeof thinkingFormat === 'string' ? thinkingFormat : undefined, models })
  }
  return views
}

/** One reasoning-declaration write outcome. */
export interface ReasoningWriteResult {
  ok: boolean
  patch?: Record<string, unknown>
  reason?: string
}

/**
 * Build the patch writing one model's reasoningEfforts declaration (or, when
 * modelId is undefined, the route's compat.thinkingFormat). Only user-layer
 * providers are writable.
 */
export function applyReasoning(
  section: LlmPiAiSection | undefined,
  userProviderIds: ReadonlySet<string> | undefined,
  provider: string,
  modelId: string | undefined,
  value: Record<string, string | null> | false | string,
): ReasoningWriteResult {
  if (userProviderIds !== undefined && !userProviderIds.has(provider)) {
    return { ok: false, reason: 'provider-not-configured' }
  }
  const profile = section?.providers?.[provider]
  if (profile === undefined) return { ok: false, reason: 'provider-not-found' }

  // Route-level thinkingFormat. pi-ai's reasoning-dispatch switches exist
  // only for the openai-completions protocol; the adapter refuses the write
  // anywhere else, so answer pre-emptively with the actionable reason.
  if (modelId === undefined) {
    if (typeof value !== 'string' || value === '') return { ok: false, reason: 'thinkingFormat must be a string' }
    const api = typeof profile.api === 'string' ? profile.api : undefined
    if (api !== 'openai-completions') {
      return {
        ok: false,
        reason: 'compat.thinkingFormat 只适用于 openai-completions 协议（当前路由：' + (api ?? '未指定')
          + '）。该协议的推理等级请直接在模型上声明 reasoningEfforts',
      }
    }
    const nextCompat = { ...(profile.compat ?? {}), thinkingFormat: value }
    return { ok: true, patch: { providers: { [provider]: { ...profile, compat: nextCompat } } } }
  }

  const error = validateEfforts(value)
  if (error !== undefined) return { ok: false, reason: error }
  const located = entryOf(profile, modelId)
  if (located === undefined) return { ok: false, reason: 'model-not-found' }
  const nextEntry = { ...located.head, reasoningEfforts: value }

  let patch: Record<string, unknown>
  if (located.kind === 'list') {
    const rebuilt = (profile.models ?? []).map((raw) => raw as unknown as Record<string, unknown>)
    rebuilt[located.index] = { ...(rebuilt[located.index] as Record<string, unknown>), reasoningEfforts: value }
    patch = { providers: { [provider]: { ...profile, models: rebuilt } } }
  } else {
    const overrides = { ...(profile.modelOverrides ?? {}) } as Record<string, unknown>
    overrides[modelId] = nextEntry
    patch = { providers: { [provider]: { modelOverrides: overrides } } }
  }
  return { ok: true, patch }
}

/* ---------------------------------------------------------------- HTTP --- */

/** Read a JSON request body (1 MB cap), rejecting on malformed JSON. */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.length === 0) return undefined
  return JSON.parse(text) as unknown
}

/** Write a JSON response. */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}
