#!/usr/bin/env node
/**
 * Bundle-size report and budget gate for the web production build.
 *
 * `pnpm bundle-report` remains the human-readable advisory command. CI uses
 * `pnpm bundle-check`, which reads `performance-budgets.json`, fails
 * on explicit budget breaches or >10% growth from the checked-in baseline,
 * and writes retained Markdown + JSON evidence under `artifacts/`. The report
 * keeps the complete JS/CSS artifact distinct from a single-locale JS/CSS
 * set: production ships every locale, but a normal session downloads only the
 * selected locale until the operator explicitly switches language.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const ASSETS_DIR = join(ROOT_DIR, 'dist', 'assets')
const BUDGETS_PATH = join(ROOT_DIR, 'performance-budgets.json')
const DEFAULT_TOP_N = 12

/** Format a byte count as a fixed-1 KiB string. */
export function kib(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`
}

/** Remove Vite's final content hash while preserving the stable asset name. */
export function logicalAssetName(name) {
  return name.replace(/-[A-Za-z0-9_-]{8}(?=\.(?:js|css)$)/, '')
}

/** Aggregate duplicate stable names (for example two lazy `helpers` chunks). */
export function aggregateEntries(entries) {
  const assets = new Map()
  for (const entry of entries) {
    const name = logicalAssetName(entry.name)
    const current = assets.get(name) ?? { name, rawBytes: 0, gzipBytes: 0, files: [] }
    current.rawBytes += entry.rawBytes
    current.gzipBytes += entry.gzipBytes
    current.files.push(entry.name)
    assets.set(name, current)
  }
  return [...assets.values()].sort((a, b) => b.rawBytes - a.rawBytes)
}

/** Render a human-readable bundle table from measured chunk entries. */
export function formatBundleReport(entries, { topN = DEFAULT_TOP_N, evaluation } = {}) {
  const sorted = [...entries].sort((a, b) => b.rawBytes - a.rawBytes)
  const totalRaw = sorted.reduce((sum, entry) => sum + entry.rawBytes, 0)
  const totalGzip = sorted.reduce((sum, entry) => sum + entry.gzipBytes, 0)
  const shown = sorted.slice(0, topN)
  const rest = sorted.slice(topN)

  const lines = [
    `## Web bundle report (${sorted.length} chunks)`,
    '',
    '| Chunk | Raw | Gzip |',
    '| --- | ---: | ---: |',
    ...shown.map((entry) => `| ${entry.name} | ${kib(entry.rawBytes)} | ${kib(entry.gzipBytes)} |`),
  ]
  if (rest.length > 0) {
    const restRaw = rest.reduce((sum, entry) => sum + entry.rawBytes, 0)
    const restGzip = rest.reduce((sum, entry) => sum + entry.gzipBytes, 0)
    lines.push(`| _(${rest.length} more)_ | ${kib(restRaw)} | ${kib(restGzip)} |`)
  }
  lines.push('', `**Total: ${kib(totalRaw)} raw · ${kib(totalGzip)} gzip**`)

  if (evaluation) {
    lines.push('', `## Performance budgets — ${evaluation.ok ? 'PASS' : 'FAIL'}`, '')
    lines.push('| Budget | Actual | Limit | Result |', '| --- | ---: | ---: | --- |')
    lines.push(
      `| Complete JS/CSS artifact | ${kib(evaluation.artifact.actualBytes)} | ${kib(evaluation.artifact.limitBytes)} | ${evaluation.artifact.ok ? 'PASS' : 'FAIL'} |`,
      `| Worst single-locale JS/CSS | ${kib(evaluation.singleLocale.actualBytes)} | ${kib(evaluation.singleLocale.limitBytes)} | ${evaluation.singleLocale.ok ? 'PASS' : 'FAIL'} |`,
    )
    if (evaluation.singleLocale.missing.length > 0) {
      lines.push('', `Missing locale assets: ${evaluation.singleLocale.missing.join(', ')}`)
    }
    for (const group of evaluation.groups) {
      lines.push(`| ${group.label} | ${kib(group.actualBytes)} | ${kib(group.limitBytes)} | ${group.ok ? 'PASS' : 'FAIL'} |`)
    }
    if (evaluation.regressions.length > 0) {
      lines.push('', '### Baseline regressions', '')
      for (const regression of evaluation.regressions) {
        lines.push(`- ${regression.name}: ${kib(regression.actualBytes)} > ${kib(regression.limitBytes)} (${regression.allowancePercent}% allowance)`)
      }
    }
    if (evaluation.newAssets.length > 0) {
      lines.push('', `New named assets (record a baseline after review): ${evaluation.newAssets.join(', ')}`)
    }
  }

  return lines.join('\n')
}

/** Evaluate explicit budgets and baseline regressions without filesystem I/O. */
export function evaluateBundleBudgets(entries, budgets) {
  const assets = aggregateEntries(entries)
  const byName = new Map(assets.map((asset) => [asset.name, asset]))
  const artifactActual = entries.reduce((sum, entry) => sum + entry.gzipBytes, 0)
  const artifactLimit = budgets.artifactGzipKiB * 1024
  const explicitlyBudgeted = new Set()

  const localeAssets = budgets.singleLocale.assets
  const missingLocaleAssets = localeAssets.filter((name) => !byName.has(name))
  const localeAssetBytes = localeAssets.map((name) => byName.get(name)?.gzipBytes ?? 0)
  const allLocaleBytes = localeAssetBytes.reduce((sum, bytes) => sum + bytes, 0)
  const largestLocaleBytes = Math.max(0, ...localeAssetBytes)
  const singleLocaleActual = artifactActual - allLocaleBytes + largestLocaleBytes
  const singleLocaleLimit = budgets.singleLocale.maxGzipKiB * 1024

  const groups = Object.entries(budgets.assetGroups).map(([id, group]) => {
    let actualBytes = 0
    const missing = []
    for (const name of group.assets) {
      explicitlyBudgeted.add(name)
      const asset = byName.get(name)
      if (asset) actualBytes += asset.gzipBytes
      else missing.push(name)
    }
    const limitBytes = group.maxGzipKiB * 1024
    return {
      id,
      label: group.label,
      assets: group.assets,
      actualBytes,
      limitBytes,
      missing,
      ok: missing.length === 0 && actualBytes <= limitBytes,
    }
  })

  const allowancePercent = budgets.unbudgetedRegressionPercent
  const regressions = []
  const newAssets = []
  for (const asset of assets) {
    if (explicitlyBudgeted.has(asset.name)) continue
    const baselineKiB = budgets.baselineGzipKiB[asset.name]
    if (baselineKiB === undefined) {
      newAssets.push(asset.name)
      continue
    }
    const limitBytes = baselineKiB * 1024 * (1 + allowancePercent / 100)
    if (asset.gzipBytes > limitBytes) {
      regressions.push({
        name: asset.name,
        actualBytes: asset.gzipBytes,
        baselineBytes: baselineKiB * 1024,
        limitBytes,
        allowancePercent,
      })
    }
  }

  const artifact = {
    actualBytes: artifactActual,
    limitBytes: artifactLimit,
    ok: artifactActual <= artifactLimit,
  }
  const singleLocale = {
    assets: localeAssets,
    missing: missingLocaleAssets,
    actualBytes: singleLocaleActual,
    limitBytes: singleLocaleLimit,
    ok: missingLocaleAssets.length === 0 && singleLocaleActual <= singleLocaleLimit,
  }
  return {
    version: budgets.version,
    ok: artifact.ok && singleLocale.ok && groups.every((group) => group.ok) && regressions.length === 0,
    artifact,
    singleLocale,
    groups,
    regressions,
    newAssets,
    assets,
  }
}

/** Measure every JavaScript and CSS chunk in a build directory. */
export function collectEntries(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js') || name.endsWith('.css'))
    .map((name) => {
      const buffer = readFileSync(join(dir, name))
      return { name, rawBytes: buffer.length, gzipBytes: gzipSync(buffer).length }
    })
}

function parseArgs(argv) {
  const options = { check: false, json: null, markdown: null }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') options.check = true
    else if (arg === '--json' || arg === '--markdown') {
      const value = argv[index + 1]
      if (!value) throw new Error(`${arg} requires a path`)
      options[arg.slice(2)] = resolve(ROOT_DIR, value)
      index += 1
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function writeOutput(path, contents) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${contents}\n`)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!existsSync(ASSETS_DIR)) {
    console.error('No build output found at dist/assets — run `pnpm build` first.')
    process.exitCode = options.check ? 1 : 0
    return
  }

  const entries = collectEntries(ASSETS_DIR)
  if (entries.length === 0) {
    console.error('No JS/CSS chunks found in dist/assets — run `pnpm build` first.')
    process.exitCode = options.check ? 1 : 0
    return
  }

  const budgets = options.check ? JSON.parse(readFileSync(BUDGETS_PATH, 'utf8')) : null
  const evaluation = budgets ? evaluateBundleBudgets(entries, budgets) : null
  const markdown = formatBundleReport(entries, { evaluation })
  console.log(markdown)

  if (options.markdown) writeOutput(options.markdown, markdown)
  if (options.json) {
    writeOutput(options.json, JSON.stringify({
      generatedAt: new Date().toISOString(),
      budgetsPath: 'performance-budgets.json',
      ...evaluation,
    }, null, 2))
  }
  if (options.check && !evaluation.ok) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
