# Repository Guidelines

## Project Overview

`dsh-model-meta-autofill` — originalFactor's fork of [QJAG1024/dsh-model-meta-autofill](https://github.com/QJAG1024/dsh-model-meta-autofill), targeting DeepSeek Harness `0.2.1-rc.5`. Install this fork with `dsh plugin --profile web add github:originalFactor/dsh-model-meta-autofill`. Keep upstream attribution and the MIT license.

DeepSeek Harness (DSH) host-side **cordis plugin** that auto-fills model metadata
(`contextWindow`, `maxTokens`, display name, input modalities) for **custom-provider** models in the `llm-pi-ai`
settings section, using the [models.dev](https://models.dev/) Model Metadata Registry.

Two delivery paths, **both read-only with respect to settings** (the settings card's own 保存 commits):

1. **Discovery-time enrichment (automatic)** — the plugin wraps the LLM service's `discoverModels`, filling only
   *missing* fields into each advertised candidate before the caller sees it.
2. **Manual "自动获取" buttons (web client half)** — DOM-injected controls that fill the editor's form inputs;
   nothing is persisted until the user presses 保存 (Apply in English).

Reference prose: `README.md` (Chinese, dense, cross-references the tests that pin each claim). Read it before
changing behavior; it documents the design rationale and the degradation boundaries.

## Architecture & Data Flow

```
build time:  models.dev api.json --(pnpm gen:data / src/dataset.ts normalizers)--> src/data/models.dev.json
             tsc (node half + client half) --> lib/*.js ; scripts/copy-data.mjs: src/data -> lib/data
runtime:     apply(ctx) -> resolveConfig -> shared ModelMetaIndex
             ensureBundled() (memoized: merge committed snapshots, per-source failure isolation)
             refreshLive() (optional: refreshOnStart / refreshIntervalMs, merges over the offline index)
             ctx.provide('modelMeta', service)      // lookup / stats / refresh / buildSectionPatch
             wrap llm.discoverModels (installDiscoveryEnrichment) -> enrich candidates when ns === 'llm-pi-ai'
             ctx.webServer: GET /model-meta-autofill/api/providers , GET /model-meta-autofill/api/catalog?ids=…
client:      src/client.ts (classic-script bundle via dsh.client) -> MutationObserver DOM injection
             -> "自动获取" buttons -> HTTP catalog lookup -> fill React-controlled inputs (native setter + input event)
```

Core invariants (do not break):

- **Fill only absent fields.** Endpoint-disclosed capacities/names always win.
- **A display name equal to the model id counts as unfilled** (case/whitespace-insensitive) so catalog names surface.
- **Never add models** the endpoint did not advertise; unknown models are returned byte-identical.
- **Never write settings.** No `ctx.settings.update` anywhere in `src/`; `buildSectionPatch` is for *callers*.
- **Scoped to `llm-pi-ai`** in three places that must stay in sync: the discovery wrap, section/`userProviderIds`
  filtering, and the client's route resolution.
- **Per-source failure isolation** in `loadBundledIndex` / `refreshLive` (collect errors, never throw out of refresh).
- Absent catalog fields must stay **absent** in API payloads (an empty value would clear user data).

## Key Directories

| Path | Purpose |
| --- | --- |
| `src/` | Plugin source (8 modules: `index`, `config`, `dataset`, `enrich`, `service`, `discovery`, `api`, `client`) |
| `src/data/` | Committed offline snapshot `models.dev.json` (423 KB, ~2 078 models) — **generated**, never hand-edit |
| `tests/` | `*.spec.ts` unit/integration specs (`node:test`, self-contained, no shared helpers) |
| `tests/integration/` | `settings-autofill.spec.ts` — boots a real profile via `@deepseek-ai/dsh-app-boot` |
| `scripts/` | `generate-snapshot.mjs` (`gen:data`), `copy-data.mjs` (build step) |
| `lib/`, `lib/types/` | **gitignored build output** (the entire published payload) |
| `deepseek-harness/` | Git submodule (SSH URL) — contains `vendor/` and `website/` with their own `AGENTS.md`; not needed for build/test of this package |

## Development Commands

```bash
pnpm typecheck    # tsc -p tsconfig.json  (src + tests, strict; excludes src/client.ts)
pnpm build        # tsc -p tsconfig.build.json && tsc -p tsconfig.client.json && node scripts/copy-data.mjs
pnpm test         # tsx --test <8 explicit spec files>   (2 client suites need a prior build)
pnpm gen:data     # node --import tsx scripts/generate-snapshot.mjs [source …]  -> src/data/{source}.json
npx tsx --test tests/dataset.spec.ts    # single spec (unit specs need no build)
```

- Node **22.19+ (22.x) or >= 24**, ESM only (`"type": "module"`). Local toolchain is **pnpm** (`pnpm-lock.yaml` v9);
  `pnpm-workspace.yaml` only allows esbuild install scripts — it is *not* a workspace definition.
- CI (`release.yml`, on main pushes, pull requests, and `v*` tags) uses `npm i --ignore-scripts --no-fund --no-audit`,
  runs typecheck → all 6 host test files → build → both client suites → pack, and uploads the tarball as an artifact.
  This fork is distributed through GitHub; CI does not publish the upstream npm package name.
- `prepare` runs `npm run build` for Git dependency installs. Keep it working from a checkout without `lib/`;
  GitHub installations must include the emitted client, host declarations, and offline snapshot. If pnpm blocks
  Git preparation, its exact dependency key belongs in the destination profile's `allowBuilds`, not this repo's file.
- No linter/formatter is configured; match existing style by hand.

## Code Conventions & Common Patterns

- **TS strictness**: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `noUnusedLocals`.
  Optional fields are built with spread conditionals (`...x === undefined ? {} : { x }`), never `undefined` values.
- **Naming**: camelCase files; `PascalCase` types/classes; `SCREAMING_SNAKE` exported defaults
  (`DEFAULT_SOURCES`, `TARGET_NAMESPACE`, `SOURCE_URLS`); factories `create*`; installers `install*`; predicates `is*`.
- **cordis DI**: `ctx.inject([deps], sctx => sctx.effect(fn, 'dsh-model-meta-autofill.<area>'))` where `fn` returns a
  disposer (routes, timers, the discovery wrap, client mount). Every added resource is disposed.
- **Read service instances with `sctx.get('llm')`** — never through the `ctx.llm` proxy (its `set` trap registers,
  so a wrap installed through it is silently lost and the Remote adapter never sees it). See `src/index.ts` comment.
- **Error handling**: per-source loops with individual try/catch accumulating `{ source, message }`; loud validation
  errors prefixed `dsh-model-meta-autofill: `; live-seam reads wrapped to return `undefined`/empty.
- **Async**: memoized fire-and-forget startup (`bundledPromise ??= …`, `void promise.then(…)`); `AbortController` +
  `setTimeout` per request composed with the caller's signal via `AbortSignal.any`; dynamic `await import()` for lazy deps.
- **Change detection**: `deepEqualJson` from `@deepseek-ai/dsh-util-values`; `undefined` return means "no change".
- **Foreign data**: structural minimal interfaces (`ModelHead`, `ProviderProfile`, `SettingsLike`) — version-tolerant.
- **Comments**: English, explaining *why* (design rationale). Chinese appears **only** in UI strings copied from or
  sent to the host page (自动获取, 保存, 模型 ID, 显示名称, 上下文窗口, 最大输出, 文本, 图片).
- **Data normalization** (`src/dataset.ts`): tolerant at the edges (unparseable → `undefined`, never throws); a model
  with no usable capacity is dropped rather than guessed; capacities parse 1024-based suffixes (`128K`, `1M`, `8GB`).
- **Client half constraints** (`src/client.ts`): the bundle is a **classic script** re-executed by the loader in a
  shared global lexical environment — *all* declarations must live inside the `require` factory (no top-level
  `const`/`let`/`class`/`import`), and the bundle must contain **no slot registration** (the keyed slot
  `settings.models.provider-card` is exclusive to other plugins; a second entry throws and fails the fiber).
- **Form filling** must go through the native `HTMLInputElement.prototype` value setter + a dispatched `input` event;
  checkboxes are clicked (never assigned) and only when not already matching. Direct `input.value = …` is silently
  discarded by React's controlled-input tracker.
- **DOM anchors** are fuzzy CSS-module matches (`rowCard`, `setupCard`, `modelListHead`, …) and English/Chinese
  `aria-label` prefixes. Expand rows through `button[aria-expanded]`; never hardcode hashed class names.
- If buttons are missing, check the live profile's `model-meta-autofill` entry for `disabled: true` before changing
  selectors. A disabled entry has no browser roster row and its providers API returns 404.

## Important Files

| File | Role |
| --- | --- |
| `src/index.ts` | Composition root: `apply()`, `ensureBundled()`, HTTP routes, `ctx.provide('modelMeta')`, discovery seam, refresh interval |
| `src/config.ts` | `Config` + schemastery schema, defaults, `TARGET_NAMESPACE = 'llm-pi-ai'`, `resolveConfig()` validation |
| `src/dataset.ts` | `normalizeEntry` / `collectEntries` / `dedupeSizedEntries`, `ModelMetaIndex` + alias resolution, `refreshLive` |
| `src/enrich.ts` | Pure fill core: `fillsFor` (the fill-missing-only rule), `enrichDiscovered`, `cleanEntry`, `buildSectionPatch`, `listMissing` |
| `src/discovery.ts` | Instance-level `discoverModels` wrap with exact-descriptor restore on dispose |
| `src/service.ts` | `ModelMetaService` contract + `declare module '@deepseek-ai/cordis'` augmentation for `ctx.modelMeta` |
| `src/api.ts` | Read-only HTTP payload builders (`listProviders`, `catalogViews`, `displayName`) |
| `src/client.ts` | Browser half: MutationObserver injection, catalog fetch, controlled-input filling, result bubble |
| `cordis.patch.yml` | `dsh.bundle.patch`: inserts the plugin config row at install time (defaults must match `src/config.ts`) |
| `package.json` | `exports` map, `dsh.bundle.patch` / `dsh.client.platform`, explicit `test` file list |
| `tsconfig.json` / `.build` / `.client` | typecheck (src+tests, excludes client) / node emit → `lib/` / standalone DOM build → `lib/client.js` |

## Runtime/Tooling Preferences

- Runtime: **Node 22.19+ (22.x) or >= 24**, ESM. `tsx` executes TS tests and scripts directly; `tsc` is the only build tool.
- Package manager: **pnpm** locally (`pnpm-lock.yaml`, single importer); CI uses plain `npm i`.
- All dev/runtime deps resolve from **npm published** `@deepseek-ai/*` packages — no harness source checkout needed.
  `@deepseek-ai/cordis`, `dsh-settings`, `dsh-util-values` are optional peers with minimum versions documented in the README.
- `lib/` is gitignored but is the **entire published artifact** (`files: ["lib/", "cordis.patch.yml"]`) — always rebuild
  before packing/publishing; never trust a stale local `lib/`.
- `src/client.ts` is excluded from the main typecheck project and compiled only under `tsconfig.client.json`
  (DOM lib, `types: []`) — node built-ins there fail at build/test time, not in the editor.
- Do not reference `tsconfig.base*.json` / `tsconfig.host.json` / a root `types/` dir — those live in the submodule or
  don't exist. `tsconfig.test.json` is dead config (no script or CI step uses it).

## Testing & QA

- Runner: **`node:test` + `node:assert/strict`**, driven by `tsx --test <explicit file list>`. No test framework config,
  no mock library — fixtures are hand-rolled stubs and tiny `lookup()` closures.
- 8 self-contained specs: `dataset`, `enrich`, `discovery`, `discovery-runtime`, `api`, `client-bundle`,
  `client-injection`, `integration/settings-autofill`.
- **Adding a spec requires editing the file list in `package.json`** (`test` script) *and* `.github/workflows/release.yml`.
- Unit/integration specs import `../src/*.ts` directly (no build). `client-bundle.spec.ts` and `client-injection.spec.ts`
  execute the built `lib/client.js` in `node:vm` realms → **run `pnpm build` first**.
- Contracts the suites pin (regressions here are real bugs):
  - fill-only-missing, disclosed values win, unknown models untouched, no model additions, order preserved;
  - the wrap is reversible and visible through `ctx.llm.remoteDiscoverModels` (real `LlmRuntime`, no stand-ins);
  - no settings writes / no 保存 presses / no editor toggles during any fill; the card stays open;
  - classic-script bundle: double execution in one realm + no top-level declarations + no slot registration;
  - fills reach React's *draft*, not just the DOM (the DOM stub models the value tracker);
  - result bubble lives detached on `body` (`position: fixed`), one at a time, removed on teardown.
- `tests/integration/settings-autofill.spec.ts` boots a real profile (`dsh-app-boot` + real `ConfigEditor`,
  `SettingsForms`, `LlmRuntime`), seeding providers in the **user layer** (profile `cordis.patch.yml`) — the plugin only
  exposes user-layer routes and never writes settings. Do not replace it with fakes.
- No coverage tooling. Behavior changes must keep `README.md` claims, `cordis.patch.yml` defaults, and `src/config.ts`
  defaults in agreement; regenerate data snapshots (`pnpm gen:data && pnpm build`) when `src/dataset.ts` normalization
  or catalog sources change.
