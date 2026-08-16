/**
 * dsh-model-meta-autofill
 *
 * A DSH host plugin that auto-fills metadata (context length, output cap,
 * display name, input modalities) for the models of custom provider routes
 * configured in the `llm-pi-ai` settings section, using the public model
 * catalog aggregated by PublicProviderConf
 * (https://github.com/ThinkInAIXYZ/PublicProviderConf).
 *
 * Behavior:
 *
 * - A bundled offline index (src/data/*.json) answers immediately, offline.
 * - An optional live refresh merges the latest dist catalogs over it at start
 *   (and on an interval), failing per-source without touching the rest.
 * - Whenever the `llm-pi-ai` section changes (a model adopted from a custom
 *   gateway discovery interrogation, a hand-entered one, a bulk edit), a
 *   pending pass fills whatever the catalog knows and the section still
 *   misses — never overwriting a value the operator set — and persists the
 *   enriched section through the settings seam. The pass is idempotent: once
 *   filled, nothing is missing, so it cannot loop.
 * - `ctx.modelMeta` exposes the index and the pure helpers to other plugins.
 *
 * The plugin only touches provider routes that already exist in the user's
 * own settings layer, and only model entries whose id it can positively size
 * (catalog entries without a context or output cap are never guessed at).
 *
 * @module dsh-model-meta-autofill
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
// Type-only import: the Context.webServer augmentation ships with this package.
import type {} from '@deepseek-ai/dsh-host-webserver'
import {
  applyAll, applyModelsAdd, applyRow, catalogView, defaultModelsUrl, listRows,
  parseModelsPayload, readJsonBody, sendJson, type NameStyle,
} from './api.ts'
import type { Config } from './config.ts'
import { DEFAULT_BASE_URL, resolveConfig, TARGET_NAMESPACE } from './config.ts'
import {
  loadBundledIndex,
  ModelMetaIndex,
  refreshLive,
  sourceId,
  type LookedUpEntry,
} from './dataset.ts'
import {
  buildSectionPatch,
  listMissing,
  type EnrichOptions,
  type LlmPiAiSection,
} from './enrich.ts'
import type { ModelMetaService } from './service.ts'

export { createModelMetaService, type ModelMetaService } from './service.ts'
export { DEFAULT_BASE_URL, DEFAULT_SOURCES, resolveConfig, TARGET_NAMESPACE } from './config.ts'
export type { Config } from './config.ts'
export {
  ModelMetaIndex,
  collectEntries,
  normalizeEntry,
  refreshLive,
  type CatalogEntry,
  type LookedUpEntry,
  type RefreshResult,
} from './dataset.ts'
export {
  buildSectionPatch,
  cleanEntry,
  enrichEntry,
  fillsFor,
  listMissing,
  type EnrichOptions,
  type LlmPiAiSection,
  type ModelEntry,
  type ProviderProfile,
} from './enrich.ts'

export const name = 'dsh-model-meta-autofill'

const NS: SettingsNamespace = settingsNamespace(TARGET_NAMESPACE)

/** How hard the initial scan retries waiting for the llm-pi-ai namespace to register. */
const INITIAL_SCAN_MAX_ATTEMPTS = 12
const INITIAL_SCAN_BACKOFF_MS = 250

/**
 * The provider routes present in the user's own settings layer. Without an
 * authoritative user view nothing is reported — an empty set keeps
 * composition-base-only providers from ever being materialized.
 */
export function userProviderIdsOf(sctx: { settings: { describe(options: { redactSecrets: boolean }): Array<{ ns: unknown; user?: unknown }> } }): ReadonlySet<string> {
  try {
    const descriptor = sctx.settings.describe({ redactSecrets: true })
      .find((entry) => String(entry.ns) === TARGET_NAMESPACE)
    const user = descriptor?.user as { providers?: Record<string, unknown> } | null | undefined
    const providers = user?.providers
    return providers === undefined
      ? new Set<string>()
      : new Set(Object.keys(providers))
  } catch {
    return new Set<string>()
  }
}

/**
 * Skip count: how many pending-enrichment passes run while a previous one is
 * still in flight. The settings commit that follows an enrich write re-fires
 * the watcher; a coalescing flag keeps overlapping passes from stacking.
 */
const IN_FLIGHT_SKIP_REASON = 'an enrichment pass is already running'

export function apply(ctx: Context, rawConfig?: Partial<Config>): void {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) {
    ctx.logger.info('dsh-model-meta-autofill: disabled by config')
    return
  }
  const enrichOptions: EnrichOptions = {
    fillName: config.fillName,
    fillInput: config.fillInput,
    // fillReasoning is reserved (pi-ai stores nothing dialect-free today).
  }

  // The shared index: bundled snapshots first, live refresh merged over them.
  // The load is memoized so an enrichment pass can await it: running the pass
  // before the index is ready would find nothing and silently skip a section
  // that still needs filling.
  const index = new ModelMetaIndex([])
  let bundledPromise: Promise<void> | undefined
  const ensureBundled = (): Promise<void> => {
    bundledPromise ??= loadBundledIndex(config.sources.map(sourceId)).then((result) => {
      // Merge the freshly loaded snapshots into the shared index this plugin
      // serves lookups from (bundled first, live refresh merged over it later).
      index.mergeFrom(result.index)
      for (const error of result.errors) {
        ctx.logger.warn('dsh-model-meta-autofill: bundled catalog "%s" failed to load: %s', error.source, error.message)
      }
    })
    return bundledPromise
  }
  void ensureBundled().then(() => {
    if (config.refreshOnStart) {
      void refreshLive(index, config.sources, DEFAULT_BASE_URL, config.timeoutMs).then((result) => {
        reportRefresh(ctx, result)
      })
    }
  })

  // Web surface: plugin-owned HTTP endpoints the settings-section client (and
  // any local caller) uses. Only mounts when the web profile provides the web
  // server — headless boots simply never activate it.
  ctx.inject(['settings', 'webServer'], (sctx) => {
    const section = (): LlmPiAiSection | undefined =>
      sctx.settings.get(NS) as LlmPiAiSection | undefined
    const lookupIndex = (id: string): LookedUpEntry | undefined => index.lookup(id)
    sctx.effect(() => {
      const disposers = [
        sctx.webServer.register({
          kind: 'exact',
          path: '/model-meta-autofill/api/status',
          handler: (_req, res) => {
            sendJson(res, 200, { enabled: config.enabled, sources: [...config.sources], entryCount: index.size })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/model-meta-autofill/api/models',
          handler: (_req, res) => {
            sendJson(res, 200, { providers: listRows(section(), lookupIndex, userProviderIdsOf(sctx)) })
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/model-meta-autofill/api/apply',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req) as { provider?: unknown; modelId?: unknown; overwrite?: unknown; nameStyle?: unknown }
              const provider = typeof body?.provider === 'string' ? body.provider : ''
              const modelId = typeof body?.modelId === 'string' ? body.modelId : ''
              if (provider === '' || modelId === '') {
                sendJson(res, 400, { ok: false, reason: 'provider and modelId are required' })
                return
              }
              const overwrite = body.overwrite !== false
              const nameStyle: NameStyle = body.nameStyle === 'vendor' ? 'vendor' : 'bare'
              const result = applyRow(section(), lookupIndex, userProviderIdsOf(sctx), provider, modelId, overwrite, nameStyle)
              if (!result.ok || result.patch === undefined) {
                sendJson(res, 200, { ok: false, reason: result.reason, provider, modelId })
                return
              }
              try {
                await sctx.settings.update(NS, result.patch)
              } catch (firstError) {
                // One retry over a FRESH snapshot: the usual transient cause
                // is a concurrent write (the auto-fill pass, the Models page)
                // committing between this request's read and its write.
                ctx.logger.warn(
                  'dsh-model-meta-autofill: apply write failed for %s/%s (%s); retrying on a fresh snapshot',
                  provider, modelId, String(firstError),
                )
                const retry = applyRow(section(), lookupIndex, userProviderIdsOf(sctx), provider, modelId, overwrite, nameStyle)
                if (!retry.ok || retry.patch === undefined) throw firstError
                await sctx.settings.update(NS, retry.patch)
              }
              sendJson(res, 200, { ok: true, applied: result.applied })
            } catch (error) {
              ctx.logger.warn('dsh-model-meta-autofill: apply failed: %s', String(error))
              const message = error instanceof Error ? (error.message || String(error)) : String(error)
              // A timed-out writer lock almost always means an orphaned
              // settings.yaml.lock left by a killed process — name the fix.
              const hint = /writer lock/i.test(message)
                ? ' | hint: ~/.dsh/settings.yaml.lock may be orphaned; if the PID inside it is not running, delete the file'
                : ''
              sendJson(res, 200, { ok: false, reason: 'write-failed', message: message + hint })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/model-meta-autofill/api/apply-all',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req) as { nameStyle?: unknown }
              const nameStyle: NameStyle = body?.nameStyle === 'vendor' ? 'vendor' : 'bare'
              const result = applyAll(section(), lookupIndex, userProviderIdsOf(sctx), nameStyle)
              if (result.patch === undefined) {
                sendJson(res, 200, { ok: true, filled: [], missed: result.missed })
                return
              }
              await sctx.settings.update(NS, result.patch)
              sendJson(res, 200, { ok: true, filled: result.filled, missed: result.missed })
            } catch (error) {
              ctx.logger.warn('dsh-model-meta-autofill: apply-all failed: %s', String(error))
              const message = error instanceof Error ? (error.message || String(error)) : String(error)
              const hint = /writer lock/i.test(message)
                ? ' | hint: ~/.dsh/settings.yaml.lock may be orphaned; if the PID inside it is not running, delete the file'
                : ''
              sendJson(res, 200, { ok: false, reason: 'write-failed', message: message + hint })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/model-meta-autofill/api/discover',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req) as { provider?: unknown; url?: unknown }
              const provider = typeof body?.provider === 'string' ? body.provider : ''
              if (provider === '') { sendJson(res, 400, { ok: false, reason: 'provider is required' }); return }
              const profile = section()?.providers?.[provider] as Record<string, unknown> | undefined
              if (profile === undefined) { sendJson(res, 200, { ok: false, reason: 'provider-not-found', provider }); return }
              const baseURL = typeof profile.baseURL === 'string' ? profile.baseURL : undefined
              const url = typeof body?.url === 'string' && body.url !== '' ? body.url : defaultModelsUrl(baseURL)
              const apiKeyEnv = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined
              // Resolve the credential on the host; the value never reaches the client.
              let apiKey: string | undefined
              if (apiKeyEnv !== undefined) {
                const credentials = (sctx as unknown as { credentials?: { resolve: (ref: string) => Promise<{ value?: string } | undefined> } }).credentials
                const hit = credentials !== undefined ? await credentials.resolve(apiKeyEnv) : undefined
                apiKey = typeof hit?.value === 'string' && hit.value !== '' ? hit.value : undefined
              }
              const controller = new AbortController()
              const timer = setTimeout(() => controller.abort(new Error('discovery timed out')), config.timeoutMs)
              let response: Response
              try {
                response = await fetch(url, {
                  headers: {
                    accept: 'application/json',
                    ...apiKey === undefined ? {} : { authorization: 'Bearer ' + apiKey },
                  },
                  signal: controller.signal,
                })
              } finally { clearTimeout(timer) }
              if (!response.ok) {
                sendJson(res, 200, { ok: false, reason: 'fetch-failed', status: response.status, url })
                return
              }
              const payload = await response.json() as unknown
              const models = parseModelsPayload(payload)
              const enriched = models.map((m) => ({ id: m.id, name: m.name, catalog: catalogView(lookupIndex(m.id)) }))
              sendJson(res, 200, { ok: true, url, count: enriched.length, models: enriched })
            } catch (error) {
              ctx.logger.warn('dsh-model-meta-autofill: discover failed: %s', String(error))
              const message = error instanceof Error ? (error.message || String(error)) : String(error)
              sendJson(res, 200, { ok: false, reason: 'fetch-failed', message })
            }
          },
        }),
        sctx.webServer.register({
          kind: 'exact',
          path: '/model-meta-autofill/api/discover/add',
          handler: async (req, res) => {
            try {
              const body = await readJsonBody(req) as { provider?: unknown; modelIds?: unknown }
              const provider = typeof body?.provider === 'string' ? body.provider : ''
              const modelIds = Array.isArray(body?.modelIds)
                ? (body.modelIds as unknown[]).filter((v): v is string => typeof v === 'string' && v !== '')
                : []
              if (provider === '' || modelIds.length === 0) {
                sendJson(res, 400, { ok: false, reason: 'provider and modelIds are required' })
                return
              }
              const result = applyModelsAdd(section(), userProviderIdsOf(sctx), provider, modelIds)
              if (!result.ok) { sendJson(res, 200, { ok: false, reason: result.reason, provider }); return }
              if (result.patch === undefined) { sendJson(res, 200, { ok: true, added: [], provider }); return }
              await sctx.settings.update(NS, result.patch)
              sendJson(res, 200, { ok: true, added: result.added ?? [], provider })
            } catch (error) {
              ctx.logger.warn('dsh-model-meta-autofill: discover/add failed: %s', String(error))
              const message = error instanceof Error ? (error.message || String(error)) : String(error)
              const hint = /writer lock/i.test(message)
                ? ' | hint: ~/.dsh/settings.yaml.lock may be orphaned; if the PID inside it is not running, delete the file'
                : ''
              sendJson(res, 200, { ok: false, reason: 'write-failed', message: message + hint })
            }
          },
        }),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'dsh-model-meta-autofill.web-api')
  })

  // Host service: index + pure helpers for other plugins/surfaces.
  const service: ModelMetaService = {
    lookup: (id) => index.lookup(id),
    stats: () => {
      return {
        sourceCount: config.sources.length,
        entryCount: index.size,
      }
    },
    refresh: async () => {
      await ensureBundled()
      const result = await refreshLive(index, config.sources, DEFAULT_BASE_URL, config.timeoutMs)
      reportRefresh(ctx, result)
      return result
    },
    buildSectionPatch: (section, optionsPatch, userProviderIds) =>
      buildSectionPatch(
        section,
        (id) => index.lookup(id),
        { ...enrichOptions, ...optionsPatch },
        userProviderIds,
      ),
  }
  ctx.provide('modelMeta', service)
  if (config.refreshIntervalMs > 0) {
    // Plain timers wrapped in an effect disposer, so the plugin needs no
    // timer-plugin dependency and stays testable on a bare context.
    ctx.effect(() => {
      const id = setInterval(() => {
        void service.refresh().catch(() => { /* per-source failures are reported inside refresh */ })
      }, config.refreshIntervalMs)
      return () => clearInterval(id)
    }, 'dsh-model-meta-autofill.refresh-interval')
  }

  // The auto-fill pass. Declared inside ctx.inject so the plugin does not
  // demand a settings service at mount: on headless boots without one, the
  // enrichment simply never activates.
  ctx.inject(['settings'], (sctx) => {
    let inFlight: Promise<void> | undefined
    let attempts = 0
    // Set while a pass is in flight when a settings/updated event lands; the
    // finishing pass then re-runs once. Without this, a "delete + re-add" pair
    // of quick consecutive writes can lose the second event (the pass for the
    // first is still flying) and leave the re-added entry unfilled.
    let pendingRescan = false

    const userProviderIds = (): ReadonlySet<string> => userProviderIdsOf(sctx)

    const runPass = (reason: string): Promise<void> => {
      if (inFlight !== undefined) {
        // Don't drop the event: remember it so the in-flight pass re-scans
        // when it settles. Coalesce repeated events into one rescan.
        pendingRescan = true
        ctx.logger.debug('dsh-model-meta-autofill: deferring pass (%s): %s', reason, IN_FLIGHT_SKIP_REASON)
        return inFlight
      }
      const pass = (async (): Promise<void> => {
        try {
          await ensureBundled()
          const section = sctx.settings.get(NS) as
            | { providers?: Record<string, never> }
            | undefined
          if (section === undefined) return
          const userIds = userProviderIds()
          const patch = buildSectionPatch(section, (id) => index.lookup(id), enrichOptions, userIds)
          if (patch === undefined) return
          const missing = listMissing(section, (id) => index.lookup(id), enrichOptions, userIds)
          if (config.dryRun) {
            ctx.logger.info(
              'dsh-model-meta-autofill: [dry-run] would fill %d entries: %s',
              missing.length,
              describeMissing(missing),
            )
            return
          }
          ctx.logger.info(
            'dsh-model-meta-autofill: filling metadata for %d model entries (%s)',
            missing.length,
            describeMissing(missing),
          )
          await sctx.settings.update(NS, patch)
          ctx.logger.info('dsh-model-meta-autofill: settings updated — the llm-pi-ai adapter will serve the filled metadata')
        } catch (error) {
          // A refused settings write (schema/validate) must not wedge the
          // watcher: log and let the next change retry.
          ctx.logger.warn('dsh-model-meta-autofill: enrichment pass failed: %s', String(error))
        }
      })()
        .finally(() => {
          inFlight = undefined
          if (pendingRescan) {
            pendingRescan = false
            void runPass('post-inflight rescan')
          }
        })
      inFlight = pass
      return pass
    }

    // Keep the initial scan retrying until the llm-pi-ai namespace exists.
    // Plain timers whose handles are cleared on the fiber's disposal.
    let retryHandle: ReturnType<typeof setTimeout> | undefined
    sctx.effect(() => () => {
      if (retryHandle !== undefined) clearTimeout(retryHandle)
    }, 'dsh-model-meta-autofill.initial-scan-cleanup')
    const scheduleInitialScan = (): void => {
      const attempt = (): void => {
        if (attempts >= INITIAL_SCAN_MAX_ATTEMPTS) return
        attempts += 1
        const section = sctx.settings.get(NS)
        if (section === undefined) {
          retryHandle = setTimeout(attempt, INITIAL_SCAN_BACKOFF_MS * Math.min(attempts, 8))
          return
        }
        void runPass('initial scan')
      }
      retryHandle = setTimeout(attempt, 0)
    }
    scheduleInitialScan()

    sctx.on('settings/updated', (ns, _next, _prev) => {
      if (String(ns) !== TARGET_NAMESPACE) return
      // The pass reads the authoritative value itself; event payload is advisory.
      void runPass('settings changed')
    })
  })
}

/** One-line description of what a pass is about to fill (for logs). */
function describeMissing(
  missing: { provider: string; id: string; fields: string[] }[],
): string {
  if (missing.length === 0) return 'nothing'
  const sample = missing.slice(0, 5).map((m) => `${m.provider}/${m.id}[${m.fields.join(',')}]`)
  const over = missing.length > 5 ? `, … (+)${missing.length - 5} more` : ''
  return sample.join(', ') + over
}

/** Log one live-refresh outcome compactly. */
function reportRefresh(ctx: Context, result: { ok: boolean; refreshed: string[]; errors: { source: string; message: string }[] }): void {
  if (result.ok) {
    ctx.logger.info('dsh-model-meta-autofill: live refresh merged %d catalog(s): %s', result.refreshed.length, result.refreshed.join(', '))
    return
  }
  const failed = result.errors.map((e) => `${e.source} (${e.message})`).join('; ')
  ctx.logger.warn('dsh-model-meta-autofill: live refresh partially failed: %s — serving bundled snapshots', failed)
}
