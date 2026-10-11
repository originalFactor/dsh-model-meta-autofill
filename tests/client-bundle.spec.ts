/**
 * The client bundle's script-level contract.
 *
 * `lib/client.js` is delivered as a **classic script**, and combos concatenate
 * several packages' bundles into one script. Top-level `const`/`let`/`class` in
 * a classic script creates a binding in the page's single global lexical
 * environment, shared by every classic script on the page and by a combo that
 * inlines this bundle. A second evaluation then fails at *parse* time with
 * `Identifier 'X' has already been declared`, so the script registers nothing
 * and client-modules reports:
 *
 *   loaded without registering "<id>" via __ModuleLoader__.load
 *
 * The official tsdown build cannot trip this: its banner opens the
 * `__ModuleLoader__.load({ factory: (require) => {` and its footer closes it, so
 * every declaration is factory-scoped. A plain `tsc` emit does not, so this
 * suite pins the invariant the emitter has to satisfy.
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

const BUNDLE = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const SOURCE = fileURLToPath(new URL('../src/client.ts', import.meta.url))

const PLUGIN_ID = 'dsh-model-meta-autofill'

/**
 * One page-like global: a single `window`, and — crucially — one shared
 * lexical environment, which is what two classic scripts on a page share.
 */
function makePage(): {
  context: vm.Context
  loaded: Array<{ id: string; factory?: (require: (spec: string) => unknown) => unknown }>
} {
  const loaded: Array<{ id: string; factory?: (require: (spec: string) => unknown) => unknown }> = []
  const sandbox: Record<string, unknown> = {
    console,
    window: {
      __ModuleLoader__: { load: (handoff: { id: string }) => { loaded.push(handoff) } },
      localStorage: { getItem: () => null, setItem: () => {} },
    },
    document: {
      querySelector: () => null,
      createElement: () => ({ setAttribute() {}, textContent: '' }),
      head: { appendChild() {} },
    },
  }
  sandbox['globalThis'] = sandbox
  return { context: vm.createContext(sandbox), loaded }
}

describe('client bundle: classic-script global scope', () => {
  it('declares no top-level lexical binding in src/client.ts', () => {
    // Static guard: it runs without a build, so CI's typecheck+test job holds
    // the line even though only the publish job builds the bundle. Only column
    // zero counts — an indented declaration is inside a function body and is
    // scoped to it.
    const source = readFileSync(SOURCE, 'utf8')
    const offenders = source.split('\n')
      .map((line, index) => ({ line, n: index + 1 }))
      .filter(({ line }) => /^(const|let|var|function|class)\s/.test(line))
      .map(({ line, n }) => `${n}: ${line.slice(0, 60)}`)
    assert.deepEqual(
      offenders, [],
      'src/client.ts must declare nothing at the top level: every declaration belongs inside the '
      + 'require-factory, or a concatenated combo/duplicate load fails to parse and registers nothing',
    )
  })

  it('registers its factory on every evaluation in one shared global scope', () => {
    assert.ok(existsSync(BUNDLE), `${BUNDLE} is missing — run the client build before this suite`)
    const source = readFileSync(BUNDLE, 'utf8')
    const { context, loaded } = makePage()

    // First evaluation: the ordinary single-script load.
    vm.runInContext(source, context, { filename: 'load-1.js' })
    assert.equal(loaded.length, 1, 'first evaluation must register the factory')
    assert.equal(loaded[0]?.id, PLUGIN_ID)

    // Second evaluation in the SAME global scope — a combo that inlined this
    // bundle having already run, then the row's own URL running again. This is
    // the exact case that failed in production.
    assert.doesNotThrow(() => {
      vm.runInContext(source, context, { filename: 'load-2.js' })
    }, 'a re-evaluated bundle must not raise a parse/declaration error')

    assert.equal(loaded.length, 2, 'second evaluation must reach __ModuleLoader__.load')
  })

  it('leaves no bundle identifier in the page global scope', () => {
    assert.ok(existsSync(BUNDLE), `${BUNDLE} is missing — run the client build before this suite`)
    const { context } = makePage()
    vm.runInContext(readFileSync(BUNDLE, 'utf8'), context, { filename: 'load.js' })
    // Any leaked top-level `const` would make this probe a redeclaration error.
    assert.doesNotThrow(() => {
      vm.runInContext(
        'const SYNC_URL = "probe"; const STYLE_ID = "probe"; const CSS_TEXT = "probe"; const SyncButton = null;',
        context,
      )
    }, 'the bundle leaked a top-level binding into the page global scope')
  })

  it('registers nothing into the occupied provider-card slot', () => {
    // Regression: registering `settings.models.provider-card` with key
    // 'llm-pi-ai' THROWS when another plugin already occupies that keyed cell
    // (a keyed cell holds one entry), which fails this plugin's fiber and
    // aborts the rest of apply. The half must attach to the rendered card
    // instead, so it declares no slot injection at all.
    assert.ok(existsSync(BUNDLE), `${BUNDLE} is missing — run the client build before this suite`)
    const source = readFileSync(BUNDLE, 'utf8')
    // The slot name may appear in prose; what must not appear is a call.
    assert.equal(
      /\.slots\s*\.\s*(inject|register)\s*\(/.test(source), false,
      'the bundle must not call into the slot registry (the per-card cell is exclusive)',
    )
    const { context, loaded } = makePage()
    vm.runInContext(source, context, { filename: 'load.js' })
    const factory = loaded[0]?.factory as
      | ((require: (spec: string) => unknown) => { name: string; inject: unknown; apply(ctx: unknown): void })
      | undefined
    assert.ok(factory !== undefined, 'the bundle must hand the loader a factory')
    const plugin = factory(() => ({}))
    assert.equal(plugin.name, 'model-meta-autofill')
    // Copy into this realm's array: a cross-realm array fails deepStrictEqual
    // on its prototype even when the contents match.
    assert.deepEqual(Array.from(plugin.inject as string[]), [])
  })
})
