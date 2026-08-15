/**
 * dsh-model-meta-autofill — browser half.
 *
 * A settings page section in the settings-panel design language: one
 * collapsible card per custom provider, each model row showing its current
 * values next to the models.dev catalog values, with a per-model fill button,
 * a prominent "Overwrite all" action, and a switch deciding whether filled
 * display names carry the vendor label ("OpenAI: GPT-5.2 Pro" vs "GPT-5.2
 * Pro"). The switch choice persists in localStorage.
 *
 * Contract constraints (client-modules): no static imports — everything is
 * taken from the loader's module table via the injected require; markup is
 * React.createElement only; styling ships inline and is injected once.
 *
 * @module dsh-model-meta-autofill/client
 */

interface ModuleLoader {
  load(handoff: { id: string; factory: (require: (spec: string) => unknown) => Record<string, unknown> }): void
}
interface DshWindow { __ModuleLoader__?: ModuleLoader }

interface MinimalReact {
  createElement(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T | (() => T)): [T, (next: T | ((prev: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
  useCallback<T>(fn: T, deps: unknown[]): T
}

interface SlotsService {
  inject(key: string, register: () => void): void
  register(options: Record<string, unknown>, component: unknown): void
}
interface ClientContext { slots: SlotsService }

interface CatalogInfo { name?: string; vendor?: string; contextWindow?: number; maxTokens?: number; input?: string[] }
interface ModelRow {
  id: string
  matched: boolean
  catalog: CatalogInfo | undefined
  configured: { name?: string; contextWindow?: number; maxTokens?: number; input?: string[] }
}
interface ProviderRows { provider: string; userConfigured: boolean; models: ModelRow[] }
type Tone = 'ok' | 'warn' | 'error'
interface DomEvent { target: { checked: boolean; value: string } }
interface ReasoningFormat { id: string; label: string; hint: string; preset: Record<string, string> }
interface ReasoningModelView {
  id: string
  isList: boolean
  declared: Record<string, string | null> | false | undefined
  catalogReasoning: boolean
  preset: string[]
  catalogLevels: string[] | undefined
}
interface ReasoningProviderView { provider: string; userConfigured: boolean; api: string | undefined; thinkingFormat: string | undefined; models: ReasoningModelView[] }

const API = '/model-meta-autofill/api'
const STYLE_KEY = 'dsh-model-meta-autofill:nameStyle'
const CSS_TEXT = "\n.dma-section { display: flex; flex-direction: column; gap: 12px; max-width: 720px; color: var(--dsw-alias-label-primary); }\n.dma-title { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; }\n.dma-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }\n.dma-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; }\n.dma-primaryButton, .dma-secondaryButton { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 4px; height: 36px; padding: 0 14px; border: none; border-radius: 18px; font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; }\n.dma-primaryButton { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }\n.dma-primaryButton:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }\n.dma-secondaryButton { border: 1px solid var(--dsw-alias-border-l2); background: transparent; color: var(--dsw-alias-label-primary); }\n.dma-secondaryButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-solid); }\n.dma-primaryButton:disabled, .dma-secondaryButton:disabled, .dma-rowButton:disabled { opacity: 0.4; cursor: default; }\n.dma-primaryButton:focus-visible, .dma-secondaryButton:focus-visible, .dma-rowButton:focus-visible, .dma-head:focus-visible, .dma-switch:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); }\n.dma-switch { box-sizing: border-box; display: inline-flex; align-items: center; gap: 8px; border: none; background: transparent; padding: 4px 2px; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: pointer; border-radius: 6px; }\n.dma-switchTrack { box-sizing: border-box; position: relative; width: 32px; height: 18px; border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); transition: background 120ms ease, border-color 120ms ease; flex: none; }\n.dma-switchTrack[data-on=\"1\"] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }\n.dma-switchKnob { position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: var(--dsw-alias-label-tertiary); transition: transform 120ms ease, background 120ms ease; }\n.dma-switchTrack[data-on=\"1\"] .dma-switchKnob { transform: translateX(14px); background: var(--dsw-alias-label-primary-foreground); }\n.dma-status { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); margin-left: auto; }\n.dma-banner { margin: 0; font-size: 12px; line-height: 18px; }\n.dma-banner[data-tone=\"ok\"] { color: var(--dsw-alias-state-success-primary); }\n.dma-banner[data-tone=\"warn\"] { color: var(--dsw-alias-state-warn-label); }\n.dma-banner[data-tone=\"error\"] { color: var(--dsw-alias-state-error-primary); }\n.dma-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }\n.dma-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }\n.dma-head { display: flex; align-items: center; gap: 10px; border: none; background: transparent; padding: 0; font: inherit; cursor: pointer; text-align: left; border-radius: 6px; color: inherit; }\n.dma-chevron { flex: none; width: 8px; height: 8px; border-right: 1.5px solid var(--dsw-alias-label-secondary); border-bottom: 1.5px solid var(--dsw-alias-label-secondary); transform: rotate(-45deg); transition: transform 120ms ease; }\n.dma-head[data-open=\"1\"] .dma-chevron { transform: rotate(45deg) translate(-1px, -1px); }\n.dma-name { font-size: 14px; line-height: 22px; font-weight: 500; color: var(--dsw-alias-label-primary); }\n.dma-tag { flex: none; padding: 1px 6px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 4px; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-secondary); }\n.dma-body { display: flex; flex-direction: column; gap: 10px; border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 12px; }\n.dma-cols { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) auto; gap: 6px; font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); padding: 0 6px; }\n.dma-entry { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 6px; }\n.dma-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 6px; }\n.dma-id { font-family: var(--ds-font-family-code); font-size: 13px; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); }\n.dma-cell { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); overflow-wrap: anywhere; }\n.dma-cell[data-strong=\"1\"] { color: var(--dsw-alias-label-secondary); }\n.dma-rowButton { box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; height: 28px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; }\n.dma-rowButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }\n.dma-rowMsg { margin: 4px 2px 0; font-size: 12px; line-height: 18px; }\n.dma-rowMsg[data-tone=\"ok\"] { color: var(--dsw-alias-state-success-primary); }\n.dma-rowMsg[data-tone=\"warn\"] { color: var(--dsw-alias-state-warn-label); }\n.dma-rowMsg[data-tone=\"error\"] { color: var(--dsw-alias-state-error-primary); }\n.dma-empty { padding: 12px; border: 1px dashed var(--dsw-alias-border-l3); border-radius: 8px; text-align: center; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }\n@media (prefers-reduced-motion: reduce) { .dma-chevron, .dma-switchTrack, .dma-switchKnob { transition: none; } }.dma-select { box-sizing: border-box; height: 28px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; max-width: 360px; } .dma-input { box-sizing: border-box; width: 100%; height: 26px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; } .dma-input:focus, .dma-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); } .dma-reasonBlock { border-top: 1px solid var(--dsw-alias-border-l2); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; } .dma-subtitle { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-secondary); } .dma-reasonFormat { display: flex; align-items: center; gap: 8px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); flex-wrap: wrap; } .dma-reasonModel { border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; padding: 8px; display: flex; flex-direction: column; gap: 6px; } .dma-reasonModelHead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; } .dma-reasonGrid { display: grid; grid-template-columns: auto 96px minmax(0, 1fr); gap: 4px 8px; align-items: center; font-size: 12px; color: var(--dsw-alias-label-secondary); } .dma-check { width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); cursor: pointer; } .dma-miniButton { box-sizing: border-box; display: inline-flex; align-items: center; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; line-height: 18px; cursor: pointer; } .dma-miniButton:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); } .dma-miniButton:disabled { opacity: 0.4; cursor: default; } .dma-miniButton:focus-visible, .dma-check:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--dsw-alias-border-l3); } .dma-reasonMsg { margin: 0; font-size: 12px; line-height: 18px; } .dma-reasonSummary { cursor: pointer; font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); list-style: none; width: fit-content; } .dma-reasonSummary::-webkit-details-marker { display: none; } .dma-reasonSummary:hover { color: var(--dsw-alias-label-secondary); } .dma-reasonGrid details > .dma-input { margin-top: 2px; }"

;(window as unknown as DshWindow).__ModuleLoader__?.load({
  id: 'dsh-model-meta-autofill',
  factory: (require: (spec: string) => unknown) => {
    const React = require('react') as MinimalReact
    const h = React.createElement.bind(React)

    const ensureStyles = (): void => {
      const doc = document
      if (doc.querySelector('style[data-plugin="dsh-model-meta-autofill"]') !== null) return
      const el = doc.createElement('style')
      el.setAttribute('data-plugin', 'dsh-model-meta-autofill')
      el.textContent = CSS_TEXT
      doc.head.appendChild(el)
    }

    const readStyle = (): 'vendor' | 'bare' => {
      try { return window.localStorage.getItem(STYLE_KEY) === 'vendor' ? 'vendor' : 'bare' } catch { return 'bare' }
    }
    const writeStyle = (value: 'vendor' | 'bare'): void => {
      try { window.localStorage.setItem(STYLE_KEY, value) } catch { /* private mode — the session default stands */ }
    }

    const fmt = (value: number | undefined): string => value === undefined ? '—' : value.toLocaleString()
    const caps = (entry: { contextWindow?: number; maxTokens?: number }): string =>
      'ctx ' + fmt(entry.contextWindow) + ' · out ' + fmt(entry.maxTokens)

    /** Same split the host applies: recover the vendor label, keep the bare name. */
    const previewName = (catalog: CatalogInfo, style: 'vendor' | 'bare'): string | undefined => {
      if (catalog.name === undefined) return undefined
      let bare = catalog.name
      let vendor = catalog.vendor
      const slash = catalog.name.indexOf('/')
      if (slash > 0 && slash < catalog.name.length - 1) {
        const prefix = catalog.name.slice(0, slash).trim()
        const rest = catalog.name.slice(slash + 1).trim()
        if (prefix !== '' && rest !== '') {
          bare = rest
          if (vendor === undefined) vendor = prefix
        }
      }
      return style === 'vendor' && vendor !== undefined ? vendor + ': ' + bare : bare
    }

    const AutoFillPanel = (): unknown => {
      const [rows, setRows] = React.useState<ProviderRows[] | null>(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState('')
      const [banner, setBanner] = React.useState<{ text: string; tone: Tone } | null>(null)
      const [messages, setMessages] = React.useState<Record<string, { text: string; tone: Tone }>>({})
      const [nameStyle, setNameStyle] = React.useState<'vendor' | 'bare'>(() => readStyle())
      const [collapsed, setCollapsed] = React.useState<Record<string, boolean>>({})
      const [reasoning, setReasoning] = React.useState<{ formats: ReasoningFormat[]; providers: ReasoningProviderView[] } | null>(null)
      const [reasonError, setReasonError] = React.useState('')
      const [effortDrafts, setEffortDrafts] = React.useState<Record<string, Record<string, string | null>>>({})
      const [reasonExpanded, setReasonExpanded] = React.useState<Record<string, boolean>>({})

      const load = React.useCallback(() => {
        fetch(API + '/models')
          .then((r) => r.json() as Promise<{ providers: ProviderRows[] }>)
          .then((data) => { setRows(data.providers ?? []); setError('') })
          .catch((e) => setError(String(e)))
      }, [])

      const loadReasoning = React.useCallback(() => {
        fetch(API + '/reasoning')
          .then((r) => r.json() as Promise<{ formats: ReasoningFormat[]; providers: ReasoningProviderView[] }>)
          .then((data) => { setReasoning(data); setReasonError('') })
          .catch((e) => setReasonError(String(e)))
      }, [])
      React.useEffect(() => { ensureStyles(); load(); loadReasoning() }, [load, loadReasoning])

      const toggleStyle = (): void => {
        setNameStyle((prev) => {
          const next = prev === 'vendor' ? 'bare' : 'vendor'
          writeStyle(next)
          return next
        })
      }

      const applyOne = React.useCallback((provider: string, modelId: string, style: 'vendor' | 'bare') => {
        const key = provider + '/' + modelId
        setBusy(key)
        fetch(API + '/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, modelId, overwrite: true, nameStyle: style }),
        })
          .then((r) => r.json() as Promise<{ ok: boolean; reason?: string; message?: string; applied?: CatalogInfo }>)
          .then((res) => {
            setBusy('')
            if (res.ok) {
              const applied = res.applied ?? {}
              setMessages((prev) => ({ ...prev, [key]: { tone: 'ok', text: '已应用 models.dev：' + caps(applied) } }))
              load()
            } else {
              const text = res.reason === 'no-match'
                ? 'models.dev 没有匹配到：' + modelId
                : '无法应用（' + (res.reason ?? 'unknown') + '）' + (res.message ? '：' + res.message : '')
              setMessages((prev) => ({ ...prev, [key]: { tone: res.reason === 'no-match' ? 'warn' : 'error', text } }))
            }
          })
          .catch((e) => { setBusy(''); setMessages((prev) => ({ ...prev, [key]: { tone: 'error', text: '请求失败：' + String(e) } })) })
      }, [load])

      const applyEverything = React.useCallback((style: 'vendor' | 'bare') => {
        setBusy('all')
        setBanner(null)
        fetch(API + '/apply-all', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ nameStyle: style }),
        })
          .then((r) => r.json() as Promise<{ ok: boolean; reason?: string; message?: string; filled?: unknown[]; missed?: { modelId: string }[] }>)
          .then((res) => {
            setBusy('')
            if (!res.ok) {
              setBanner({ tone: 'error', text: '全部覆盖失败（' + (res.reason ?? 'unknown') + '）' + (res.message ? '：' + res.message : '') })
              return
            }
            const filled = res.filled ?? []
            const missed = res.missed ?? []
            const text = '已覆盖 ' + filled.length + ' 个模型'
              + (missed.length > 0 ? '；未匹配：' + missed.map((m) => m.modelId).join('、') : '')
            setBanner({ tone: missed.length > 0 ? 'warn' : 'ok', text })
            load()
          })
          .catch((e) => { setBusy(''); setBanner({ tone: 'error', text: '请求失败：' + String(e) }) })
      }, [load])

      const LEVEL_NAMES: Record<string, string> = { off: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大' }
      /** Wire value one level sends under one format's preset (off is null). */
      const wireFor = (format: ReasoningFormat | undefined, level: string): string | null => {
        if (level === 'off') return null
        if (format === undefined) return level
        if (Object.keys(format.preset).length === 0) return 'on'
        return format.preset[level] ?? level
      }
      /** Draft key for one provider/model pair. */
      const draftKey = (provider: string, modelId: string): string => provider + '/' + modelId

      const seedDraft = (provider: string, model: ReasoningModelView, format: ReasoningFormat | undefined): Record<string, string | null> => {
        if (model.declared !== undefined && model.declared !== false) return { ...model.declared }
        const draft: Record<string, string | null> = {}
        for (const level of model.preset) draft[level] = wireFor(format, level)
        return draft
      }

      const currentDraft = (provider: string, model: ReasoningModelView, format: ReasoningFormat | undefined): Record<string, string | null> => {
        const key = draftKey(provider, model.id)
        return effortDrafts[key] ?? seedDraft(provider, model, format)
      }

      const postReasoning = React.useCallback((provider: string, payload: Record<string, unknown>, done: (ok: boolean, reason?: string) => void) => {
        setBusy('reason:' + provider)
        fetch(API + '/reasoning/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider, ...payload }),
        })
          .then((r) => r.json() as Promise<{ ok: boolean; reason?: string; message?: string }>)
          .then((res) => { setBusy(''); done(res.ok, res.ok ? undefined : (res.reason ?? '') + (res.message ? ': ' + res.message : '')) })
          .catch((e) => { setBusy(''); done(false, String(e)) })
      }, [])

      const setProviderFormat = React.useCallback((provider: string, format: string) => {
        postReasoning(provider, { thinkingFormat: format }, (ok, reason) => {
          if (ok) { loadReasoning(); load() }
          else setMessages((prev) => ({ ...prev, ['format:' + provider]: { tone: 'error', text: reason ?? '' } }))
        })
      }, [postReasoning, load, loadReasoning])

      const saveEfforts = React.useCallback((provider: string, model: ReasoningModelView, efforts: Record<string, string | null>) => {
        postReasoning(provider, { modelId: model.id, efforts }, (ok, reason) => {
          const key = draftKey(provider, model.id)
          if (ok) {
            setMessages((prev) => ({ ...prev, [key]: { tone: 'ok', text: '思考等级已写入：' + model.id } }))
            setEffortDrafts((prev) => { const next = { ...prev }; delete next[key]; return next })
            loadReasoning()
          } else {
            setMessages((prev) => ({ ...prev, [key]: { tone: 'error', text: reason ?? '' } }))
          }
        })
      }, [postReasoning, loadReasoning])

      const disableReasoning = React.useCallback((provider: string, model: ReasoningModelView) => {
        postReasoning(provider, { modelId: model.id, efforts: false }, (ok, reason) => {
          const key = draftKey(provider, model.id)
          if (ok) {
            setMessages((prev) => ({ ...prev, [key]: { tone: 'ok', text: '已声明为非推理：' + model.id } }))
            loadReasoning()
          } else {
            setMessages((prev) => ({ ...prev, [key]: { tone: 'error', text: reason ?? '' } }))
          }
        })
      }, [postReasoning, loadReasoning])

      if (rows === null) return h('div', { className: 'dma-section' }, h('div', { className: 'dma-empty' }, '正在加载模型列表…'))

      const totalModels = rows.reduce((n, p) => n + p.models.length, 0)
      const matchedModels = rows.reduce((n, p) => n + p.models.filter((m) => m.matched).length, 0)

      const children: unknown[] = [
        h('h2', { key: 'title', className: 'dma-title' }, '模型元数据自动填充'),
        h('p', { key: 'intro', className: 'dma-intro' }, '从 models.dev 目录为自定义供应商的模型填充上下文长度、输出上限、显示名称与输入模态。'),
        h('div', { key: 'toolbar', className: 'dma-toolbar' },
          h('button', {
            className: 'dma-primaryButton',
            disabled: busy !== '' || totalModels === 0,
            onClick: () => { applyEverything(nameStyle) },
          }, busy === 'all' ? '覆盖中…' : '全部覆盖'),
          h('button', {
            className: 'dma-switch',
            role: 'switch',
            'aria-checked': nameStyle === 'vendor',
            onClick: toggleStyle,
          },
            h('span', { className: 'dma-switchTrack', 'data-on': nameStyle === 'vendor' ? '1' : '0' },
              h('span', { className: 'dma-switchKnob' })),
            '显示名称携带厂商名',
          ),
          h('button', { className: 'dma-secondaryButton', disabled: busy !== '', onClick: () => { load() } }, '刷新'),
          h('span', { className: 'dma-status' }, '共 ' + totalModels + ' 个模型 · 已匹配 ' + matchedModels),
        ),
      ]
      if (error !== '') children.push(h('p', { key: 'err', className: 'dma-banner', 'data-tone': 'error' }, '加载失败：' + error))
      if (reasonError !== '') children.push(h('p', { key: 'rerr', className: 'dma-banner', 'data-tone': 'error' }, '思考等级加载失败：' + reasonError))
      if (banner !== null) children.push(h('p', { key: 'banner', className: 'dma-banner', 'data-tone': banner.tone }, banner.text))
      if (rows.length === 0) children.push(h('div', { key: 'empty', className: 'dma-empty' }, '尚未配置自定义供应商。'))

      const cards: unknown[] = []
      for (const provider of rows) {
        const open = collapsed[provider.provider] !== true
        const matched = provider.models.filter((m) => m.matched).length
        const headChildren: unknown[] = [
          h('span', { key: 'chev', className: 'dma-chevron' }),
          h('span', { key: 'name', className: 'dma-name' }, provider.provider),
          h('span', { key: 'count', className: 'dma-tag' }, provider.models.length + ' 个模型'),
          h('span', { key: 'match', className: 'dma-tag' }, '已匹配 ' + matched),
        ]
        if (!provider.userConfigured) headChildren.push(h('span', { key: 'ro', className: 'dma-tag' }, '非用户配置'))
        const cardChildren: unknown[] = [
          h('button', {
            key: 'head',
            className: 'dma-head',
            'data-open': open ? '1' : '0',
            'aria-expanded': open,
            onClick: () => { setCollapsed((prev) => ({ ...prev, [provider.provider]: open })) },
          }, ...headChildren),
        ]
        if (open) {
          const bodyChildren: unknown[] = [
            h('div', { key: 'cols', className: 'dma-cols', 'aria-hidden': 'true' },
              h('span', null, '模型'),
              h('span', null, '当前配置'),
              h('span', null, 'models.dev'),
              h('span', null, '操作'),
            ),
          ]
          for (const model of provider.models) {
            const key = provider.provider + '/' + model.id
            const message = messages[key]
            const configuredBits: string[] = []
            if (model.configured.name !== undefined) configuredBits.push(model.configured.name)
            configuredBits.push(caps(model.configured))
            const catalogBits: string[] = []
            if (model.matched && model.catalog !== undefined) {
              const name = previewName(model.catalog, nameStyle)
              if (name !== undefined) catalogBits.push(name)
              catalogBits.push(caps(model.catalog))
            }
            const rowChildren: unknown[] = [
              h('div', { key: 'entry', className: 'dma-entry' },
                h('div', { className: 'dma-row' },
                  h('span', { className: 'dma-id', title: model.id }, model.id),
                  h('span', { className: 'dma-cell' }, configuredBits.join(' · ')),
                  model.matched
                    ? h('span', { className: 'dma-cell', 'data-strong': '1' }, catalogBits.join(' · '))
                    : h('span', { className: 'dma-cell' }, '未收录'),
                  h('button', {
                    className: 'dma-rowButton',
                    disabled: !model.matched || !provider.userConfigured || busy !== '',
                    onClick: () => { applyOne(provider.provider, model.id, nameStyle) },
                  }, busy === key ? '应用中…' : (model.matched ? '填充' : '无匹配')),
                ),
                message === undefined ? null : h('p', { className: 'dma-rowMsg', 'data-tone': message.tone }, message.text),
              ),
            ]
            bodyChildren.push(h('div', { key: model.id }, ...rowChildren))
          }
          cardChildren.push(h('div', { key: 'body', className: 'dma-body' }, ...bodyChildren))

          /* ------------------------------ reasoning declaration block --- */
          const reasonBlock: unknown[] = [h('div', { key: 't', className: 'dma-subtitle' }, '思考等级')]
          const rview = reasoning === null ? undefined : reasoning.providers.find((p) => p.provider === provider.provider)
          if (!provider.userConfigured) {
            reasonBlock.push(h('p', { key: 'ro', className: 'dma-intro' }, '该供应商不在用户层，只读。'))
          } else if (reasoning === null) {
            reasonBlock.push(h('p', { key: 'load', className: 'dma-intro' }, '加载中…'))
          } else if (rview === undefined) {
            reasonBlock.push(h('p', { key: 'none', className: 'dma-intro' }, '未取到该供应商的推理声明状态。'))
          } else {
            // compat.thinkingFormat dispatches only for openai-completions;
            // every other protocol (openai-responses, anthropic-messages, ...)
            // carries its model's reasoning natively, so per-model level
            // declaration is the whole story for those routes.
            const completions = rview.api === 'openai-completions'
            const fmt = completions ? reasoning.formats.find((f) => f.id === rview.thinkingFormat) : undefined
            const fmtMsg = messages['format:' + provider.provider]
            if (completions) {
              reasonBlock.push(h('div', { key: 'fmt', className: 'dma-reasonFormat' },
                h('span', null, 'wire 协议（compat.thinkingFormat）：'),
                h('select', {
                  className: 'dma-select',
                  value: rview.thinkingFormat ?? '',
                  disabled: busy !== '',
                  onChange: (e: DomEvent) => { if (e.target.value !== '') { setProviderFormat(provider.provider, e.target.value) } },
                },
                  rview.thinkingFormat === undefined ? h('option', { key: '-', value: '' }, '— 未指定（自动）') : null,
                  ...reasoning.formats.map((f) => h('option', { key: f.id, value: f.id }, f.label)),
                ),
                fmt !== undefined ? h('span', null, fmt.hint) : h('span', null, '先选 wire 协议，再声明模型等级。'),
              ))
            } else {
              reasonBlock.push(h('div', { key: 'fmt', className: 'dma-reasonFormat' },
                h('span', null, 'wire 协议：' + (rview.api ?? '未指定')
                  + ' — 该协议的推理参数原生分发，不需要也不接受 compat.thinkingFormat；直接为模型声明等级即可。'),
              ))
            }
            if (fmtMsg !== undefined) reasonBlock.push(h('p', { key: 'fmtmsg', className: 'dma-reasonMsg', 'data-tone': fmtMsg.tone }, fmtMsg.text))
            const LEVELS_ALL = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
            for (const model of rview.models) {
              const key = draftKey(provider.provider, model.id)
              const message = messages[key]
              const draft = currentDraft(provider.provider, model, fmt)
              const status = model.declared === undefined ? '未声明' : model.declared === false ? '非推理' : Object.keys(model.declared).length + ' 档'
              const catalogNote = model.catalogReasoning
                ? (model.catalogLevels !== undefined && model.catalogLevels.length > 0 ? 'models.dev：推理 · ' + model.catalogLevels.join('/') : 'models.dev：推理 · 开关')
                : 'models.dev：非推理'
              const gridCells: unknown[] = []
              for (const level of LEVELS_ALL) {
                const on = Object.prototype.hasOwnProperty.call(draft, level)
                const wire = draft[level]
                // The wire value is preset for every checked level; only a
                // gateway speaking a nonstandard spelling needs it, so it sits
                // behind a disclosure instead of crowding the row.
                gridCells.push(
                  h('input', { key: level + ':cb', type: 'checkbox', className: 'dma-check', checked: on, 'aria-label': level,
                    onChange: (e: DomEvent) => { setEffortDrafts((prev) => { const base = { ...(prev[key] ?? seedDraft(provider.provider, model, fmt)) }; if (e.target.checked) { base[level] = wireFor(fmt, level) } else { delete base[level] } return { ...prev, [key]: base } }) } }),
                  h('span', { key: level + ':lb' }, LEVEL_NAMES[level] ?? level),
                  h('details', { key: level + ':wi' },
                    h('summary', { className: 'dma-reasonSummary' }, wire === null || wire === '' ? '留空（off = 不发参数）' : 'wire 值：' + wire),
                    h('input', { type: 'text', className: 'dma-input', value: wire ?? '', disabled: !on,
                      onChange: (e: DomEvent) => { setEffortDrafts((prev) => { const base = { ...(prev[key] ?? seedDraft(provider.provider, model, fmt)) }; base[level] = e.target.value; return { ...prev, [key]: base } }) } }),
                  ),
                )
              }
              reasonBlock.push(h('details', { key: model.id, className: 'dma-reasonModel' },
                h('summary', { className: 'dma-reasonModelHead' },
                  h('span', { className: 'dma-id' }, model.id),
                  h('span', { className: 'dma-tag' }, status),
                  h('span', { className: 'dma-tag' }, catalogNote),
                ),
                h('div', { className: 'dma-reasonGrid' }, ...gridCells),
                h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                  h('button', { className: 'dma-miniButton', disabled: busy !== '', onClick: () => {
                    const efforts: Record<string, string | null> = {}
                    for (const [level, wire] of Object.entries(draft)) {
                      if (level === 'off') { efforts.off = wire === '' || wire === null ? null : wire; continue }
                      if (typeof wire !== 'string' || wire === '') {
                        setMessages((prev) => ({ ...prev, [key]: { tone: 'error', text: '等级 ' + level + ' 需要填写 wire 值（只有 off 可留空）' } }))
                        return
                      }
                      efforts[level] = wire
                    }
                    if (Object.keys(efforts).length === 0) {
                      setMessages((prev) => ({ ...prev, [key]: { tone: 'error', text: '至少勾选一个等级，或声明为非推理' } }))
                      return
                    }
                    saveEfforts(provider.provider, model, efforts)
                  } }, '应用等级'),
                  h('button', { className: 'dma-miniButton', disabled: busy !== '', onClick: () => {
                    const seeded = seedDraft(provider.provider, model, fmt)
                    if (Object.keys(seeded).length === 0) {
                      setMessages((prev) => ({ ...prev, [key]: { tone: 'warn', text: 'models.dev 没有记录该模型的推理档位；可手动勾选' } }))
                      return
                    }
                    setEffortDrafts((prev) => ({ ...prev, [key]: seeded }))
                    setMessages((prev) => ({ ...prev, [key]: { tone: 'ok', text: '已按 models.dev 记录的档位预填，检查后点“应用等级”' } }))
                  } }, '按 models.dev 预填'),
                  h('button', { className: 'dma-miniButton', disabled: busy !== '', onClick: () => { disableReasoning(provider.provider, model) } }, '声明非推理'),
                ),
                message === undefined ? null : h('p', { className: 'dma-reasonMsg', 'data-tone': message.tone }, message.text),
              ))
            }
          }
          cardChildren.push(h('div', { key: 'reason', className: 'dma-reasonBlock' }, ...reasonBlock))
        }
        cards.push(h('li', { key: provider.provider, className: 'dma-card' }, ...cardChildren))
      }
      children.push(h('ul', { key: 'cards', className: 'dma-cards' }, ...cards))
      return h('div', { className: 'dma-section' }, ...children)
    }

    return {
      name: 'model-meta-autofill',
      inject: ['slots'],
      apply(ctx: ClientContext) {
        ctx.slots.inject('settings.section', () => {
          ctx.slots.register(
            { name: 'settings.section', id: 'model-meta-autofill', order: 210, label: '模型元数据' },
            AutoFillPanel,
          )
        })
      },
    }
  },
})
