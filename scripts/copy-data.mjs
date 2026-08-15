#!/usr/bin/env node
// Copy the bundled snapshot files next to the emitted lib output, so the
// built package resolves ./data/ exactly like the source layout does.
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
await mkdir(join(root, 'lib', 'data'), { recursive: true })
await cp(join(root, 'src', 'data'), join(root, 'lib', 'data'), { recursive: true })
console.log('copied src/data -> lib/data')
