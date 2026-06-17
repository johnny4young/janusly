#!/usr/bin/env node
/**
 * Bundle-size report for the web production build.
 *
 * Reads the built `apps/web/dist/assets/*.{js,css}` chunks, sorts them by raw
 * size, and prints a Markdown table of the heaviest chunks (raw + gzip KB) plus
 * a one-line total. Advisory only — it records where the bundle weight sits so
 * an operator can see regressions; it never fails a build.
 *
 * Usage: `pnpm build` first, then `pnpm bundle-report` (or `node scripts/bundle-report.mjs`).
 * If `dist/assets` is missing it prints a friendly note and exits 0.
 *
 * `formatBundleReport` + `kib` are pure (no I/O) so they can be unit-tested.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ASSETS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'web', 'dist', 'assets')

/** Default number of chunks to list before collapsing the rest into a remainder row. */
const DEFAULT_TOP_N = 12

/** Format a byte count as a fixed-1 KiB string (e.g. `236.4 KB`). Pure. */
export function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`
}

/**
 * Render the bundle table from already-measured chunk entries. Pure (no I/O) so
 * it is unit-testable. `entries` is `{ name, rawBytes, gzipBytes }[]`; the result
 * is a Markdown string: a sorted top-N table, a "(N more …)" remainder row when
 * truncated, and total raw/gzip lines.
 */
export function formatBundleReport(entries, { topN = DEFAULT_TOP_N } = {}) {
  const sorted = [...entries].sort((a, b) => b.rawBytes - a.rawBytes)
  const totalRaw = sorted.reduce((sum, e) => sum + e.rawBytes, 0)
  const totalGzip = sorted.reduce((sum, e) => sum + e.gzipBytes, 0)
  const shown = sorted.slice(0, topN)
  const rest = sorted.slice(topN)

  const lines = [
    `## Web bundle report (${sorted.length} chunks)`,
    '',
    '| Chunk | Raw | Gzip |',
    '| --- | ---: | ---: |',
    ...shown.map((e) => `| ${e.name} | ${kib(e.rawBytes)} | ${kib(e.gzipBytes)} |`),
  ]
  if (rest.length > 0) {
    const restRaw = rest.reduce((sum, e) => sum + e.rawBytes, 0)
    const restGzip = rest.reduce((sum, e) => sum + e.gzipBytes, 0)
    lines.push(`| _(${rest.length} more)_ | ${kib(restRaw)} | ${kib(restGzip)} |`)
  }
  lines.push('', `**Total: ${kib(totalRaw)} raw · ${kib(totalGzip)} gzip**`)
  return lines.join('\n')
}

/** Measure every JS/CSS chunk in `dir`. Side-effecting (reads files). */
function collectEntries(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
    .map((name) => {
      const buf = readFileSync(join(dir, name))
      return { name, rawBytes: buf.length, gzipBytes: gzipSync(buf).length }
    })
}

function main() {
  if (!existsSync(ASSETS_DIR)) {
    console.log('No build output found at apps/web/dist/assets — run `pnpm build` first.')
    return
  }
  const entries = collectEntries(ASSETS_DIR)
  if (entries.length === 0) {
    console.log('No JS/CSS chunks found in apps/web/dist/assets — run `pnpm build` first.')
    return
  }
  console.log(formatBundleReport(entries))
}

// Only run when invoked directly (not when imported by the test).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main()
}
