#!/usr/bin/env node
/**
 * generate-snapshot.mjs — fetch the configured model catalogs and write the
 * normalized offline snapshot files bundled with the plugin.
 *
 *   node --import tsx scripts/generate-snapshot.mjs [source ...]
 *
 * Default source: models.dev (see src/config.ts for the runtime
 * defaults). Every snapshot is normalized through the plugin's own
 * src/dataset.ts (single source of truth), deduplicated per base model id,
 * and keeps only the fields the plugin consumes, so the shipped data stays
 * small and reviewable.
 *
 * Sources:
 *   - models.dev  — the Model Metadata Registry (https://models.dev/api.json)
 *   - aihubmix/... — optional PublicProviderConf dist (https://github.com/ThinkInAIXYZ/PublicProviderConf); pass the name as an argument
 *   - any https:// URL to a compatible payload
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectEntries,
  dedupeSizedEntries,
  SOURCE_URLS,
  sourceId,
} from '../src/dataset.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DATA_DIR = join(ROOT, 'src', 'data')
const PPC_BASE = process.env.PPC_BASE_URL
  ?? 'https://raw.githubusercontent.com/ThinkInAIXYZ/PublicProviderConf/main/dist/'

const DEFAULT_SOURCES = ['models.dev']

/** The live URL for a source id (URLs pass through). */
function liveUrl(id) {
  if (id.startsWith('http://') || id.startsWith('https://')) return id
  return SOURCE_URLS[id] ?? `${PPC_BASE}${id}.json`
}

async function fetchSource(source) {
  const url = liveUrl(source)
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) {
    throw new Error(`GET ${url} answered ${response.status}`)
  }
  const payload = await response.json()
  return { url, payload }
}

const sources = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SOURCES
await mkdir(DATA_DIR, { recursive: true })

for (const rawSource of sources) {
  const source = sourceId(rawSource)
  const { url, payload } = await fetchSource(source)
  const entries = dedupeSizedEntries(collectEntries(payload))
  const snapshot = {
    source,
    url,
    fetchedAt: new Date().toISOString(),
    modelCount: entries.length,
    models: entries,
  }
  const path = join(DATA_DIR, `${source}.json`)
  await writeFile(path, JSON.stringify(snapshot, null, 2) + '\n')
  console.log(`wrote ${path}: ${entries.length} models from ${url}`)
}
