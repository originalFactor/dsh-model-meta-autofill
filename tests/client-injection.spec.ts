/**
 * The browser half's DOM injection, executed against a minimal document.
 *
 * Two controls share one label. The provider control joins the 模型目录 heading
 * of an open card, writes the whole route, and then reloads the card. Each
 * model-row control joins the 输入类型 line inside one row, writes only that
 * model, and reloads nothing. These are the load-bearing behaviors: find each
 * anchor, resolve a card title to a route id, resolve a row's model id AT CLICK
 * TIME, mount exactly one control per anchor, place them on the right lines,
 * reload (or deliberately not reload) the card, report an outcome truthfully,
 * and remove everything on teardown.
 *
 * The document here is a small stub rather than jsdom: it implements only the
 * subset the injector uses. Two details make the reload testable rather than
 * vacuous:
 *
 * - structural mutations notify the registered MutationObservers on a
 *   microtask, the way the browser batches them, so the injector's
 *   re-injection after a card reload is exercised for real;
 * - the card's ROWS come from a store that LAGS the settings document, which is
 *   what the live page does. A reopened card therefore shows the pre-write
 *   values until the store catches up, and the test can hold it back to prove
 *   the reload retries instead of reporting an early success.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))

/* --------------------------------------------------------- mutation bus --- */

/** Observers listening for structural changes, mirroring MutationObserver. */
const observers = new Set<() => void>()
let notifyScheduled = false

/** Notify observers on a microtask, coalescing a burst into one pass. */
function notifyMutation(): void {
  if (notifyScheduled) return
  notifyScheduled = true
  queueMicrotask(() => {
    notifyScheduled = false
    for (const callback of Array.from(observers)) callback()
  })
}

/* ------------------------------------------------------------------ DOM --- */

class StubElement {
  tagName: string
  children: StubElement[] = []
  parentElement: StubElement | null = null
  attributes: Record<string, string> = {}
  isConnected = true
  className = ''
  type = ''
  title = ''
  disabled = false
  checked = false
  /** Layout stand-ins, so the result bubble can size and place itself. */
  offsetWidth = 120
  offsetHeight = 26
  inlineStyle: Record<string, string> = {}
  listeners: Record<string, Array<() => void>> = {}
  private ownText = ''
  private ownValue = ''
  /**
   * React's tracked value for a controlled input, and the last value React
   * actually accepted into the draft. `undefined` means the node is not
   * controlled. See `reactify`.
   */
  trackedValue: string | undefined = undefined
  draftValue: string | undefined = undefined

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
  }

  /**
   * The PROTOTYPE-level accessor, standing in for `HTMLInputElement.prototype`'s
   * native `value` setter: it changes the DOM value and leaves React's tracker
   * alone. That separation is the whole point, so it is modeled explicitly.
   */
  get value(): string { return this.ownValue }
  set value(next: string) { this.ownValue = next }
  /** What the native setter does; named so the intent is not lost. */
  setNativeValue(next: string): void { this.ownValue = next }

  /**
   * Make this input React-controlled, the way the real editor's are. React
   * installs an INSTANCE-level `value` accessor that writes the DOM value AND
   * its tracker, so assigning `input.value` leaves tracker === DOM and the next
   * `input` event looks like a no-op. Its change plugin then only adopts a value
   * when the two differ.
   *
   * A fill that assigns `input.value` therefore cannot update the draft here —
   * which is what makes these tests able to tell a correct fill from a naive one
   * instead of passing either way.
   */
  reactify(): StubElement {
    this.trackedValue = this.ownValue
    Object.defineProperty(this, 'value', {
      configurable: true,
      enumerable: true,
      get: () => this.ownValue,
      set: (next: string) => {
        this.ownValue = next
        this.trackedValue = next
      },
    })
    // React's ChangeEventPlugin: adopt the DOM value only when it diverges from
    // what React last rendered.
    this.addEventListener('input', () => {
      if (this.trackedValue === this.ownValue) return
      this.trackedValue = this.ownValue
      this.draftValue = this.ownValue
    })
    return this
  }

  /** Mirrors the real DOM: a node's text includes its descendants'. */
  get textContent(): string {
    return this.ownText + this.children.map(child => child.textContent).join('')
  }
  /** Assigning replaces every child, as in the real DOM. */
  set textContent(value: string) {
    this.ownText = value
    for (const child of this.children) child.parentElement = null
    this.children = []
    notifyMutation()
  }

  appendChild(child: StubElement): StubElement {
    child.parentElement = this
    this.children.push(child)
    notifyMutation()
    return child
  }
  insertAdjacentElement(_position: string, element: StubElement): StubElement {
    return this.before(element)
  }
  /** Insert immediately before this node, as the provider control does. */
  before(element: StubElement): StubElement {
    const parent = this.parentElement
    if (parent === null) return element
    const index = parent.children.indexOf(this)
    element.parentElement = parent
    parent.children.splice(index < 0 ? parent.children.length : index, 0, element)
    notifyMutation()
    return element
  }
  /** Detach this subtree; every descendant goes with it, as in the real DOM. */
  remove(): void {
    const parent = this.parentElement
    if (parent !== null) {
      const index = parent.children.indexOf(this)
      if (index >= 0) parent.children.splice(index, 1)
    }
    this.parentElement = null
    this.disconnect()
    notifyMutation()
  }
  private disconnect(): void {
    this.isConnected = false
    for (const child of this.children) child.disconnect()
  }
  setAttribute(name: string, value: string): void { this.attributes[name] = value }
  getAttribute(name: string): string | null { return this.attributes[name] ?? null }
  /** Inline styles, written through `el.style.left = ...` as the bubble does. */
  get style(): Record<string, string> { return this.inlineStyle }
  /** Where this node sits; fixed values are enough to place a bubble. */
  getBoundingClientRect(): { top: number; bottom: number; left: number; right: number; width: number; height: number } {
    const top = 100
    const left = 200
    return {
      top, left, bottom: top + this.offsetHeight, right: left + this.offsetWidth,
      width: this.offsetWidth, height: this.offsetHeight,
    }
  }
  addEventListener(type: string, fn: () => void): void {
    ;(this.listeners[type] ??= []).push(fn)
  }
  click(): void { for (const fn of this.listeners['click'] ?? []) fn() }
  /** Run every listener for one event type, as dispatching would. */
  dispatchEvent(event: { type?: string }): boolean {
    const type = event?.type ?? 'input'
    for (const fn of this.listeners[type] ?? []) fn()
    return true
  }
  /** Nearest ancestor (or self) matching a selector, as the real DOM does. */
  closest(selector: string): StubElement | null {
    let current: StubElement | null = this
    while (current !== null) {
      if (current.matches(selector)) return current
      current = current.parentElement
    }
    return null
  }

  /** Classes are whitespace-separated on `className`, as in the real DOM. */
  get classList(): string[] { return this.className.split(/\s+/).filter(Boolean) }

  /** `[class*="x"]`, a plain `.class`, a tag, or `tag[attr]` / `tag[attr="v"]`. */
  matches(selector: string): boolean {
    const attr = /^\[class\*="([^"]+)"\]$/.exec(selector)
    if (attr !== null) return this.className.includes(attr[1]!)
    const tagged = /^([a-z]+)\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(selector)
    if (tagged !== null) {
      if (this.tagName !== tagged[1]!.toUpperCase()) return false
      const wanted = this.attributes[tagged[2]!]
      if (wanted === undefined) return false
      return tagged[3] === undefined || wanted === tagged[3]
    }
    if (/^[a-z]+$/.test(selector)) return this.tagName === selector.toUpperCase()
    if (selector.startsWith('.')) return this.classList.includes(selector.slice(1))
    return false
  }

  /** Every element in this subtree, excluding the node itself (like querySelectorAll). */
  descendants(): StubElement[] {
    const out: StubElement[] = []
    const walk = (node: StubElement): void => {
      for (const child of node.children) { out.push(child); walk(child) }
    }
    walk(this)
    return out
  }
  querySelector(selector: string): StubElement | null {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1)
      return this.descendants().find(node => node.classList.includes(cls)) ?? null
    }
    return this.descendants().find(node => node.matches(selector)) ?? null
  }
  querySelectorAll(selector: string): StubElement[] {
    if (selector.startsWith('.')) {
      const cls = selector.slice(1)
      return this.descendants().filter(node => node.classList.includes(cls))
    }
    if (selector.startsWith('style[')) return []
    return this.descendants().filter(node => node.matches(selector))
  }
}

const h = (tag: string, className = ''): StubElement => {
  const el = new StubElement(tag)
  el.className = className
  return el
}

/** One model row, shaped like ModelRow.tsx. */
interface Row {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: ('text' | 'image')[]
}

/** Spell a capacity the way the page does, so the comparison is round-tripped. */
const capacityText = (value: number | undefined): string => {
  if (value === undefined) return ''
  if (Number.isInteger(value) && value > 0) {
    if (value % 1_000_000 === 0) return `${String(value / 1_000_000)}M`
    if (value % 1_000 === 0) return `${String(value / 1_000)}K`
  }
  return String(value)
}

function makeRow(model: Row, expanded: boolean): StubElement {
  const entry = h('div', '_hash_modelEntry')
  const row = h('div', '_hash_modelRow')
  // Every field is React-controlled, as the real editor's are.
  const idInput = h('input', '_hash_input').reactify()
  idInput.value = model.id
  idInput.setAttribute('aria-label', '模型 ID 1')
  row.appendChild(idInput)
  const nameInput = h('input', '_hash_input').reactify()
  nameInput.value = model.name ?? ''
  nameInput.setAttribute('aria-label', '显示名称 1')
  row.appendChild(nameInput)
  // The expand control the reload clicks to reveal the capacity fields.
  const toggle = h('button', '_hash_iconButton')
  toggle.textContent = '模型选项'
  row.appendChild(toggle)
  entry.appendChild(row)
  if (expanded) {
    entry.appendChild(makeBody(model))
  } else {
    // A collapsed row grows its body when the expand control is clicked, which
    // is what the reload and the per-model fill both rely on.
    toggle.addEventListener('click', () => { entry.appendChild(makeBody(model)) })
  }
  return entry
}

/** One row's expanded body: the capacity fields plus the 输入类型 line. */
function makeBody(model: Row): StubElement {
  const body = h('div', '_hash_modelAdvanced')
  const contextInput = h('input', '_hash_input').reactify()
  contextInput.value = capacityText(model.contextWindow)
  contextInput.setAttribute('aria-label', '上下文窗口 1')
  body.appendChild(contextInput)
  const maxInput = h('input', '_hash_input').reactify()
  maxInput.value = capacityText(model.maxTokens)
  maxInput.setAttribute('aria-label', '最大输出 token 数 1')
  body.appendChild(maxInput)
  body.appendChild(makeInputTypes(model.input))
  return body
}

/**
 * The 输入类型 line: a fieldset with one labelled checkbox per modality, plus
 * the modelInputChoices holder the per-model control anchors on. Clicking a
 * checkbox toggles it, as the app's controlled Checkbox does — so a fill that
 * clicks an already-matching box would turn it OFF, which is the trap the
 * implementation has to avoid.
 */
function makeInputTypes(input?: ('text' | 'image')[]): StubElement {
  const fieldset = h('fieldset', '_hash_modelInputTypes')
  fieldset.appendChild(h('legend', '_hash_modelFieldLabel'))
  const choices = h('div', '_hash_modelInputChoices')
  for (const [modality, label] of [['text', '文本'], ['image', '图片']] as const) {
    const wrapper = h('label', '_hash_checkbox')
    const box = h('input', '_hash_checkboxInput')
    box.setAttribute('type', 'checkbox')
    box.checked = input?.includes(modality) === true
    box.addEventListener('click', () => { box.checked = !box.checked })
    wrapper.appendChild(box)
    const text = h('span', '')
    text.textContent = label
    wrapper.appendChild(text)
    choices.appendChild(wrapper)
  }
  fieldset.appendChild(choices)
  return fieldset
}

/** A card whose editor reads its rows from a source that can lag the document. */
interface Card {
  element: StubElement
  /** Open or close the editor; reopening re-reads the current rows. */
  setEditor(open: boolean): void
  /** How many times the 编辑 toggle has been clicked. */
  toggles(): number
  /** How many times the editor's 保存 was pressed. */
  saves(): number
  /** Make the next 保存 attempt refuse with this text instead of committing. */
  setSaveError(text: string | undefined): void
}

/**
 * Build a card shaped like the real one: rowCard > rowHead plus rowActions,
 * then, while the editor is open, the 模型目录 section, its model rows, and the
 * editor's action row.
 *
 * `rowsOf` is consulted every time the editor opens, so a source that changes
 * underneath is observed the way the live store behaves.
 *
 * The stub reproduces the two behaviors the provider control depends on: the
 * editor's 保存 COMMITS AND CLOSES the card (`apply()` calls `onClose(true)`),
 * and a refused commit leaves the card open with an error line instead.
 */
function makeCard(options: {
  title: string
  rowsOf: () => Row[]
  expanded?: boolean
  editorOpen?: boolean
  /** Wire 编辑 to actually toggle; false leaves it inert. */
  toggle?: boolean
  /** Called when 保存 commits, so a test can order it against the sync. */
  onCommit?: () => void
}): Card {
  const card = h('li', '_hash_rowCard')
  let clicks = 0
  let saves = 0
  let open = options.editorOpen === true
  let saveError: string | undefined
  let catalog: StubElement | undefined

  const rowHead = h('div', '_hash_rowHead')
  const identity = h('span', '_hash_rowIdentity')
  const name = h('span', '_hash_rowName')
  name.textContent = options.title
  identity.appendChild(name)
  rowHead.appendChild(identity)
  const rowActions = h('span', '_hash_rowActions')
  const edit = h('button', '_hash_secondaryButton')
  edit.textContent = '编辑'
  const remove = h('button', '_hash_dangerButton')
  remove.textContent = '删除'
  rowActions.appendChild(edit)
  rowActions.appendChild(remove)
  rowHead.appendChild(rowActions)
  card.appendChild(rowHead)

  const setEditor = (next: boolean): void => {
    if (next === open) return
    open = next
    if (next) {
      // Reopening re-reads the rows, as the editor's mount-time draft does.
      catalog = build()
      card.appendChild(catalog)
    } else {
      catalog?.remove()
      catalog = undefined
    }
  }

  /** Rebuild the editor subtree from the current rows. */
  const build = (): StubElement => {
    const section = h('section', '_hash_modelCatalog')
    const listHead = h('div', '_hash_modelListHead')
    const heading = h('div', '_hash_modelCatalogHeading')
    const headingTitle = h('span', '_hash_modelCatalogTitle')
    headingTitle.textContent = '模型目录'
    heading.appendChild(headingTitle)
    listHead.appendChild(heading)
    const reset = h('button', '_hash_linkButton')
    reset.textContent = '恢复默认模型'
    listHead.appendChild(reset)
    const fetchModels = h('button', '_hash_linkButton')
    fetchModels.textContent = '获取可用模型'
    listHead.appendChild(fetchModels)
    section.appendChild(listHead)
    const list = h('div', '_hash_modelList')
    for (const model of options.rowsOf()) list.appendChild(makeRow(model, options.expanded === true))
    section.appendChild(list)
    // The model list's own error line, which sits ABOVE the card's. The card
    // reads every error line, so a single query would watch the wrong one.
    const listFailure = h('p', '_hash_error')
    section.appendChild(listFailure)
    const actions = h('div', '_hash_editorActions')
    const cancel = h('button', '_hash_secondaryButton')
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => { setEditor(false) })
    const save = h('button', '_hash_primaryButton')
    save.textContent = '保存'
    save.addEventListener('click', () => {
      saves += 1
      options.onCommit?.()
      if (saveError !== undefined) {
        // A refusal keeps the card open and shows why, as `apply()` does.
        const failure = h('p', '_hash_error')
        failure.textContent = saveError
        actions.appendChild(failure)
        return
      }
      // Success commits and closes the card: `apply()` calls onClose(true).
      setEditor(false)
    })
    actions.appendChild(cancel)
    actions.appendChild(save)
    section.appendChild(actions)
    return section
  }

  if (options.toggle !== false) {
    edit.addEventListener('click', () => { clicks += 1; setEditor(!open) })
  }
  if (open) { catalog = build(); card.appendChild(catalog) }

  return {
    element: card,
    setEditor,
    toggles: () => clicks,
    saves: () => saves,
    setSaveError: (text) => { saveError = text },
  }
}

interface Page {
  document: { body: StubElement }
  fetchCalls: Array<{ url: string; method: string; body: unknown }>
  replies: Record<string, unknown>
  /** Make the next N provider-list replies answer this payload. */
  setProviders: (rows: ProviderRow[]) => void
  flush: () => Promise<void>
  waitReal: (ms: number) => Promise<void>
  teardown: () => void
}

interface ProviderRow { provider: string; displayName: string; models?: Row[] }

/** Boot the bundle in a fresh realm with one `body` element. */
function makePage(): Page {
  const body = new StubElement('body')
  const head = new StubElement('head')
  observers.clear()
  const fetchCalls: Array<{ url: string; method: string; body: unknown }> = []
  const replies: Record<string, unknown> = {}
  let teardown = (): void => {}

  class StubMutationObserver {
    constructor(private readonly callback: () => void) {}
    observe(): void { observers.add(this.callback) }
    disconnect(): void { observers.delete(this.callback) }
  }

  const document = {
    body,
    head,
    querySelector: (selector: string) => {
      if (selector.startsWith('style[')) {
        return head.children.find(node => node.tagName === 'STYLE'
          && node.getAttribute('data-plugin') === 'dsh-model-meta-autofill') ?? null
      }
      return body.querySelector(selector)
    },
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    createElement: (tag: string) => new StubElement(tag),
  }

  // The prototype the implementation reaches for when clearing React's
  // tracker. Its `value` setter is the stub's native one, which deliberately
  // does NOT touch the tracker — the same asymmetry the real DOM has.
  const inputPrototype: Record<string, unknown> = {}
  Object.defineProperty(inputPrototype, 'value', {
    configurable: true,
    get: () => '',
    set: function (this: unknown, next: string) {
      if (next !== undefined) (this as StubElement).setNativeValue(next)
    },
  })
  const sandbox: Record<string, unknown> = {
    console,
    document,
    MutationObserver: StubMutationObserver,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    HTMLInputElement: { prototype: inputPrototype },
    Event: class { readonly type: string; constructor(type: string) { this.type = type } },
    fetch: (url: string, init?: { method?: string; body?: string }) => {
      fetchCalls.push({
        url,
        method: init?.method ?? 'GET',
        body: init?.body === undefined ? undefined : JSON.parse(init.body) as unknown,
      })
      return Promise.resolve({ json: () => Promise.resolve(replies[url] ?? replies[url.split('?')[0]!] ?? {}) })
    },
  }
  const loaded: Array<{ id: string; factory?: () => unknown }> = []
  sandbox['window'] = {
    // Reached as `window.HTMLInputElement` in the bundle, as it is in a page.
    HTMLInputElement: { prototype: inputPrototype },
    // The bubble clamps itself to the viewport.
    innerWidth: 1280,
    __ModuleLoader__: { load: (handoff: { id: string; factory?: () => unknown }) => { loaded.push(handoff) } },
  }
  sandbox['globalThis'] = sandbox

  const context = vm.createContext(sandbox)
  vm.runInContext(readFileSync(BUNDLE, 'utf8'), context, { filename: 'client.js' })
  const plugin = (loaded[0]?.factory as () => {
    name: string
    inject: unknown
    apply(ctx: { effect: (fn: () => () => void) => void }): void
  })()
  plugin.apply({ effect: (fn) => { teardown = fn() } })

  return {
    document: { body },
    fetchCalls,
    replies,
    setProviders: (rows) => { replies['/model-meta-autofill/api/providers'] = { providers: rows } },
    // Drain the mutation microtask, the fetch promise chain, and any pending
    // zero-delay timers the injector's polling uses.
    flush: async () => {
      for (let i = 0; i < 12; i += 1) await new Promise(resolve => { setTimeout(resolve, 0) })
    },
    // For paths that END in the injector's commit timeout: let real time pass
    // so the safety net expires and the fallback report can run.
    waitReal: async (ms: number) => { await new Promise(resolve => { setTimeout(resolve, ms) }) },
    teardown: () => { teardown() },
  }
}

const buttonsIn = (root: StubElement): StubElement[] =>
  root.querySelectorAll('.dmaSync').map(node => node.querySelector('.dma-syncButton')!)

const syncCalls = (page: Page): Array<{ url: string; method: string; body: unknown }> =>
  page.fetchCalls.filter(call => call.url === '/model-meta-autofill/api/sync')

/** Every catalog READ the page made, in order. */
const catalogCalls = (page: Page): string[] =>
  page.fetchCalls.filter(call => call.url.startsWith('/model-meta-autofill/api/catalog')).map(call => call.url)

/** The input in one row whose aria-label starts with the given text. */
const inputOf = (entry: StubElement, prefix: string): StubElement | undefined =>
  entry.querySelectorAll('input[aria-label]').find(node => (node.getAttribute('aria-label') ?? '').startsWith(prefix))

/** What the field currently SHOWS. */
const inputValue = (entry: StubElement, prefix: string): string | undefined =>
  inputOf(entry, prefix)?.value

/**
 * What React's draft for the field now holds, which is what 保存 would send.
 * A fill that assigns `input.value` directly leaves this stale, so asserting on
 * it is what distinguishes a real draft update from a cosmetic one.
 */
const draftValue = (entry: StubElement, prefix: string): string | undefined =>
  inputOf(entry, prefix)?.draftValue

/** Whether each 输入类型 checkbox is ticked, keyed by its visible label. */
const checkboxState = (root: StubElement): Record<string, boolean> => {
  const out: Record<string, boolean> = {}
  for (const box of root.querySelectorAll('input[type="checkbox"]')) {
    const label = box.closest('label')?.textContent?.trim()
    if (label !== undefined && label !== '') out[label] = box.checked
  }
  return out
}

/** The bubble's text, read from where it is actually rendered. */
const bubbleText = (page: Page): string | undefined =>
  page.document.body.querySelector('.dma-bubble')?.textContent

/**
 * The last outcome the plugin showed, wherever it chose to put it.
 *
 * It deliberately renders results in a detached bubble rather than inline, so
 * the assertions read the bubble; a status line inside the 输入类型 row used to
 * wrap that row onto a second line.
 */
const outcomeText = (page: Page): string | undefined => bubbleText(page)

const ROWS: Row[] = [{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4-pro' }]

/* --------------------------------------------------------------- tests --- */

describe('client bundle: DOM injection onto provider cards', () => {
  it('ships a bundle (build before this suite)', () => {
    assert.ok(existsSync(BUNDLE), `${BUNDLE} is missing — run the client build before this suite`)
  })

  it('mounts the provider control in the 模型目录 heading, before 获取可用模型', async () => {
    const page = makePage()
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()

    const listHead = card.element.querySelector('[class*="modelListHead"]')!
    assert.equal(listHead.querySelectorAll('.dmaSync').length, 1)
    // Among the line's controls, the injection sits between 恢复默认模型 and
    // 获取可用模型 rather than after them.
    assert.deepEqual(
      listHead.children
        .filter(child => child.tagName === 'BUTTON' || child.classList.includes('dmaSync'))
        .map(child => child.classList.includes('dmaSync') ? '自动获取' : child.textContent),
      ['恢复默认模型', '自动获取', '获取可用模型'],
    )
    page.teardown()
  })

  it('mounts the provider control only while the editor is open', async () => {
    const page = makePage()
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    assert.equal(card.element.querySelectorAll('.dmaSync').length, 0, 'a closed card carries no control')
    page.teardown()
  })

  it('mounts one control per OPEN model row, on the 输入类型 line, and none when collapsed', async () => {
    const page = makePage()
    const card = makeCard({
      title: 'WorkBuddy',
      rowsOf: () => [{ id: 'a' }, { id: 'b' }, { id: 'collapsed' }],
      expanded: false,
      editorOpen: true,
    })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    // No row is expanded, so no 输入类型 line exists to join.
    assert.equal(card.element.querySelectorAll('[class*="modelInputChoices"]').length, 0)
    assert.equal(card.element.querySelectorAll('.dmaSync').length, 1, 'only the provider control')

    const expanded = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS, expanded: true, editorOpen: true })
    page.document.body.appendChild(expanded.element)
    await page.flush()
    const lines = expanded.element.querySelectorAll('[class*="modelInputChoices"]')
    assert.equal(lines.length, 2, 'one per row')
    for (const line of lines) assert.equal(line.querySelectorAll('.dmaSync').length, 1)
    page.teardown()
  })

  it('leaves a card alone until its title resolves to a known route', async () => {
    const page = makePage()
    const card = makeCard({ title: 'Unknown Route', rowsOf: () => ROWS, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'gateway', displayName: 'Gateway', models: ROWS }])
    await page.flush()
    assert.equal(card.element.querySelectorAll('.dmaSync').length, 0)
    page.teardown()
  })

  it('does not duplicate controls across re-renders, and removes them all on teardown', async () => {
    const page = makePage()
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    const first = card.element.querySelectorAll('.dmaSync').length
    assert.equal(first, 3, 'one provider control plus two row controls')

    // React re-renders constantly; every pass must be idempotent.
    await page.flush()
    assert.equal(card.element.querySelectorAll('.dmaSync').length, first, 'no duplicates')

    page.teardown()
    assert.equal(card.element.querySelectorAll('.dmaSync').length, 0, 'teardown removes every control')
  })

  it('fills EVERY row of the card, and commits nothing by itself', async () => {
    // The provider control writes the catalog values into each row's own inputs
    // and leaves the card's 保存 to commit, so the open draft is never
    // invalidated and no external write happens.
    const page = makePage()
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    page.replies['/model-meta-autofill/api/catalog'] = {
      ok: true,
      models: {
        'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxTokens: 384_000 },
        'deepseek-v4-pro': { id: 'deepseek-v4-pro', contextWindow: 128_000 },
      },
      unknown: [],
    }

    buttonsIn(card.element)[0]!.click()
    await page.flush()

    // ONE request covering both rows, ids in row order.
    assert.deepEqual(catalogCalls(page), [
      '/model-meta-autofill/api/catalog?ids=deepseek-v4-flash%2Cdeepseek-v4-pro',
    ])
    // Nothing is written to settings and the card is never reloaded.
    assert.equal(syncCalls(page).length, 0, 'a fill never writes settings')
    assert.equal(card.toggles(), 0, 'a fill never closes or reopens the card')
    assert.equal(card.saves(), 0, 'and never presses 保存')

    const entries = card.element.querySelectorAll('[class*="modelEntry"]')
    assert.equal(inputValue(entries[0]!, '显示名称'), 'DeepSeek V4 Flash')
    assert.equal(inputValue(entries[0]!, '上下文窗口'), '1M')
    assert.equal(inputValue(entries[0]!, '最大输出'), '384K')
    assert.equal(inputValue(entries[1]!, '上下文窗口'), '128K')
    // The second row declares no output cap, so that field is left alone rather
    // than blanked: an absent catalog value must never clear a user's.
    assert.equal(inputValue(entries[1]!, '最大输出'), '')
    assert.equal(outcomeText(page), '已填入 2 行，点「保存」写入')
    page.teardown()
  })

  it('reaches the Draft, not just the DOM, for every row it fills', async () => {
    // A fill that assigned `input.value` would leave React's draft stale — the
    // field would look right and 保存 would write nothing. The stub models that
    // tracker, so these assertions fail if the fill regresses to assignment.
    const page = makePage()
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    page.replies['/model-meta-autofill/api/catalog'] = {
      ok: true,
      models: {
        'deepseek-v4-flash': { id: 'deepseek-v4-flash', contextWindow: 1_000_000 },
        'deepseek-v4-pro': { id: 'deepseek-v4-pro', contextWindow: 128_000 },
      },
      unknown: [],
    }

    buttonsIn(card.element)[0]!.click()
    await page.flush()

    const entries = card.element.querySelectorAll('[class*="modelEntry"]')
    assert.equal(draftValue(entries[0]!, '上下文窗口'), '1M')
    assert.equal(draftValue(entries[1]!, '上下文窗口'), '128K')
    page.teardown()
  })

  it('leaves models the catalog does not know completely untouched', async () => {
    // The point of the whole design: a private model the catalog cannot answer
    // for keeps whatever the user put there.
    const page = makePage()
    const rows: Row[] = [
      { id: 'deepseek-v4-flash', contextWindow: 12_345 },
      { id: 'my-private-model', name: 'My Own Name', contextWindow: 4242, maxTokens: 111 },
    ]
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => rows, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: rows }])
    await page.flush()
    page.replies['/model-meta-autofill/api/catalog'] = {
      ok: true,
      models: { 'deepseek-v4-flash': { id: 'deepseek-v4-flash', contextWindow: 1_000_000 } },
      unknown: ['my-private-model'],
    }

    buttonsIn(card.element)[0]!.click()
    await page.flush()

    const entries = card.element.querySelectorAll('[class*="modelEntry"]')
    assert.equal(inputValue(entries[0]!, '上下文窗口'), '1M', 'the known model is filled')
    // The private row is byte-identical to what the user had.
    assert.equal(inputValue(entries[1]!, '显示名称'), 'My Own Name')
    assert.equal(inputValue(entries[1]!, '上下文窗口'), '4242')
    assert.equal(inputValue(entries[1]!, '最大输出'), '111')
    assert.equal(outcomeText(page), '已填入 1 行，点「保存」写入，1 个目录未收录')
    page.teardown()
  })

  it('reports a card whose models the catalog does not know at all', async () => {
    const page = makePage()
    const rows: Row[] = [{ id: 'private-a' }, { id: 'private-b' }]
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => rows, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: rows }])
    await page.flush()
    page.replies['/model-meta-autofill/api/catalog'] = { ok: true, models: {}, unknown: ['private-a', 'private-b'] }

    buttonsIn(card.element)[0]!.click()
    await page.flush()

    assert.equal(outcomeText(page), '目录未收录这些模型，2 个目录未收录')
    assert.equal(page.document.body.querySelector('.dma-bubble')?.getAttribute('data-tone'), 'warn')
    page.teardown()
  })

  it('skips unnamed rows instead of treating them as a catalog gap', async () => {
    // A blank model id is a row the user has not named yet, not a model the
    // catalog failed to answer for, and the request must not carry a blank.
    const page = makePage()
    const rows: Row[] = [{ id: '' }, { id: 'deepseek-v4-flash' }]
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => rows, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: rows }])
    await page.flush()
    page.replies['/model-meta-autofill/api/catalog'] = {
      ok: true,
      models: { 'deepseek-v4-flash': { id: 'deepseek-v4-flash', contextWindow: 1_000_000 } },
      unknown: [],
    }

    buttonsIn(card.element)[0]!.click()
    await page.flush()

    assert.deepEqual(catalogCalls(page), ['/model-meta-autofill/api/catalog?ids=deepseek-v4-flash'])
    assert.equal(outcomeText(page), '已填入 1 行，点「保存」写入')
    page.teardown()
  })

  it('fills a row whose body is still collapsed, expanding it first', async () => {
    // A collapsed row renders no inputs, so the fill has to open it to reach
    // them; the values must land in the draft either way.
    const page = makePage()
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS, expanded: false, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    page.replies['/model-meta-autofill/api/catalog'] = {
      ok: true,
      models: { 'deepseek-v4-flash': { id: 'deepseek-v4-flash', contextWindow: 1_000_000 } },
      unknown: [],
    }

    buttonsIn(card.element)[0]!.click()
    await page.flush()

    const entry = card.element.querySelectorAll('[class*="modelEntry"]')[0]!
    assert.equal(inputValue(entry, '上下文窗口'), '1M')
    assert.equal(draftValue(entry, '上下文窗口'), '1M')
    page.teardown()
  })

  it('reports a request failure rather than pretending the rows were filled', async () => {
    const page = makePage()
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    // The host refuses the read outright.
    page.replies['/model-meta-autofill/api/catalog'] = { ok: false, reason: 'ids is required' }

    buttonsIn(card.element)[0]!.click()
    await page.flush()

    assert.equal(outcomeText(page), '目录没有可填的字段')
    const entries = card.element.querySelectorAll('[class*="modelEntry"]')
    assert.equal(inputValue(entries[0]!, '上下文窗口'), '', 'nothing was written')
    page.teardown()
  })

  it('fills ONE row from the catalog and never reloads the card', async () => {
    const page = makePage()
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    page.replies['/model-meta-autofill/api/catalog'] = {
      ok: true,
      models: {
        'deepseek-v4-flash': { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1_000_000, maxTokens: 384_000 },
      },
      unknown: [],
    }

    const choices = card.element.querySelector('[class*="modelInputChoices"]')!
    choices.querySelector('.dma-syncButton')!.click()
    await page.flush()

    // Only this row's id travels, so a row control cannot widen into the card.
    assert.deepEqual(catalogCalls(page), ['/model-meta-autofill/api/catalog?ids=deepseek-v4-flash'])
    assert.equal(syncCalls(page).length, 0, 'a row fill never writes settings')
    assert.equal(outcomeText(page), '已填入 显示名称 / 上下文窗口 / 最大输出，点「保存」写入')

    const entries = card.element.querySelectorAll('[class*="modelEntry"]')
    assert.equal(inputValue(entries[0]!, '显示名称'), 'DeepSeek V4 Flash')
    assert.equal(draftValue(entries[0]!, '上下文窗口'), '1M')
    // The sibling row is untouched.
    assert.equal(inputValue(entries[1]!, '上下文窗口'), '')
    assert.equal(card.toggles(), 0, 'a per-model fill never touches the card')
    page.teardown()
  })

  it('shows the outcome in a bubble, not as content inside the row', async () => {
    // Regression: an inline status line inside the 输入类型 row wrapped that row
    // onto a second line, changing the page's layout. The result must be
    // rendered out of flow instead, so showing one cannot move anything.
    const page = makePage()
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    page.replies['/model-meta-autofill/api/catalog'] = {
      ok: true, models: { 'deepseek-v4-flash': { id: 'deepseek-v4-flash', maxTokens: 384_000 } }, unknown: [],
    }

    const choices = card.element.querySelector('[class*="modelInputChoices"]')!
    choices.querySelector('.dma-syncButton')!.click()
    await page.flush()

    const bubble = page.document.body.querySelector('.dma-bubble')
    assert.ok(bubble, 'the outcome is rendered as a bubble')
    assert.equal(bubble?.parentElement?.tagName, 'BODY', 'and not inside the editor')
    assert.equal(bubble?.getAttribute('data-tone'), 'ok')
    // Nothing textual was added inside the row's own line: it holds the two
    // modality checkboxes plus the injected control, and no status text.
    assert.equal(choices.children.length, 3)
    assert.ok(!choices.textContent.includes('已填入'), 'no status text inside the row it would reflow')
    page.teardown()
  })

  it('keeps only one bubble at a time, and clears it on teardown', async () => {
    const page = makePage()
    const card = makeCard({ title: 'WorkBuddy', rowsOf: () => ROWS, expanded: true, editorOpen: true })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    page.replies['/model-meta-autofill/api/catalog'] = { ok: true, models: {}, unknown: ['deepseek-v4-flash'] }

    const button = card.element.querySelector('[class*="modelInputChoices"]')!.querySelector('.dma-syncButton')!
    button.click()
    await page.flush()
    button.click()
    await page.flush()

    assert.equal(page.document.body.querySelectorAll('.dma-bubble').length, 1)
    page.teardown()
    assert.equal(page.document.body.querySelectorAll('.dma-bubble').length, 0)
  })

  it('ticks 输入类型 without turning an already-matching box off', async () => {
    const page = makePage()
    const card = makeCard({
      title: 'WorkBuddy',
      rowsOf: () => [{ id: 'deepseek-v4-flash', input: ['text'] }],
      expanded: true,
      editorOpen: true,
    })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    // The catalog says this model takes both, and the row already has 文本.
    page.replies['/model-meta-autofill/api/catalog'] = {
      ok: true, models: { 'deepseek-v4-flash': { id: 'deepseek-v4-flash', input: ['text', 'image'] } }, unknown: [],
    }

    card.element.querySelector('[class*="modelInputChoices"]')!.querySelector('.dma-syncButton')!.click()
    await page.flush()

    assert.deepEqual(checkboxState(card.element), { 文本: true, 图片: true })
    page.teardown()
  })

  it('resolves a row id at CLICK time, so an edited id is the one looked up', async () => {
    const page = makePage()
    const card = makeCard({
      title: 'WorkBuddy',
      rowsOf: () => [{ id: 'deepseek-v4-flash' }],
      expanded: true,
      editorOpen: true,
    })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    page.replies['/model-meta-autofill/api/catalog'] = {
      ok: true, models: { 'renamed-id': { id: 'renamed-id', contextWindow: 1_000_000 } }, unknown: [],
    }

    // The id input is a controlled field: its value changes with no DOM
    // mutation, so a control that captured the id at mount would go stale here.
    const idInput = card.element.querySelector('input[aria-label]')!
    idInput.value = 'renamed-id'
    card.element.querySelector('[class*="modelInputChoices"]')!.querySelector('.dma-syncButton')!.click()
    await page.flush()

    assert.deepEqual(catalogCalls(page), ['/model-meta-autofill/api/catalog?ids=renamed-id'])
    page.teardown()
  })

  it('refuses to look up an empty row id instead of widening to the card', async () => {
    const page = makePage()
    const card = makeCard({
      title: 'WorkBuddy',
      rowsOf: () => [{ id: '' }],
      expanded: true,
      editorOpen: true,
    })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()

    const choices = card.element.querySelector('[class*="modelInputChoices"]')!
    choices.querySelector('.dma-syncButton')!.click()
    await page.flush()

    assert.equal(catalogCalls(page).length, 0, 'no request is sent without a model id')
    assert.equal(outcomeText(page), '请先填写模型 ID')
    assert.equal(card.toggles(), 0, 'and nothing is reloaded')
    page.teardown()
  })

  it('reports a catalog gap for one row with its own tone', async () => {
    const page = makePage()
    const card = makeCard({
      title: 'WorkBuddy',
      rowsOf: () => [{ id: 'x' }],
      expanded: true,
      editorOpen: true,
    })
    page.document.body.appendChild(card.element)
    page.setProviders([{ provider: 'workbuddy', displayName: 'WorkBuddy', models: ROWS }])
    await page.flush()
    const rowButton = (): StubElement =>
      card.element.querySelector('[class*="modelInputChoices"]')!.querySelector('.dma-syncButton')!
    const rowMsg = (): { text: string | undefined; tone: string | null } => ({
      text: bubbleText(page),
      tone: page.document.body.querySelector('.dma-bubble')?.getAttribute('data-tone') ?? null,
    })

    // A model the catalog does not know is an answer, not an error.
    page.replies['/model-meta-autofill/api/catalog'] = { ok: true, models: {}, unknown: ['x'] }
    rowButton().click()
    await page.flush()
    assert.equal(rowMsg().text, '目录未收录该模型')
    assert.equal(rowMsg().tone, 'warn')
    assert.equal(rowButton().disabled, false)

    // Known, but with no field this row can take.
    page.replies['/model-meta-autofill/api/catalog'] = { ok: true, models: { x: { id: 'x' } }, unknown: [] }
    rowButton().click()
    await page.flush()
    assert.equal(rowMsg().text, '目录没有可填的字段')
    assert.equal(rowMsg().tone, 'warn')
    page.teardown()
  })
})
