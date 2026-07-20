import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  aggregateEntries,
  evaluateBundleBudgets,
  formatBundleReport,
  kib,
  logicalAssetName,
} from './bundle-report.mjs'

test('kib formats bytes as fixed-1 KB', () => {
  assert.equal(kib(0), '0.0 KB')
  assert.equal(kib(1024), '1.0 KB')
  assert.equal(kib(236 * 1024), '236.0 KB')
})

test('formatBundleReport sorts chunks by raw size desc and totals raw + gzip', () => {
  const out = formatBundleReport([
    { name: 'small.js', rawBytes: 1024, gzipBytes: 512 },
    { name: 'big.js', rawBytes: 4096, gzipBytes: 1024 },
  ])
  // Heaviest first.
  assert.ok(out.indexOf('big.js') < out.indexOf('small.js'))
  assert.ok(out.includes('**Total: 5.0 KB raw · 1.5 KB gzip**'))
  assert.ok(out.includes('| Chunk | Raw | Gzip |'))
})

test('formatBundleReport collapses chunks beyond topN into a remainder row', () => {
  const entries = Array.from({ length: 15 }, (_, i) => ({
    name: `c${i}.js`,
    rawBytes: (15 - i) * 1024,
    gzipBytes: 100,
  }))
  const out = formatBundleReport(entries, { topN: 12 })
  assert.ok(out.includes('_(3 more)_'))
  // The remainder row sums the 3 smallest (1+2+3 KiB raw).
  assert.ok(out.includes('| _(3 more)_ | 6.0 KB |'))
})

test('logicalAssetName strips Vite hashes and aggregation combines stable duplicates', () => {
  assert.equal(logicalAssetName('CanvasWorkspace-DsbM59L5.js'), 'CanvasWorkspace.js')
  assert.equal(logicalAssetName('RollbackConfirmDialog-BykkoxF-.js'), 'RollbackConfirmDialog.js')

  const aggregated = aggregateEntries([
    { name: 'helpers-12345678.js', rawBytes: 100, gzipBytes: 30 },
    { name: 'helpers-abcdefgh.js', rawBytes: 200, gzipBytes: 50 },
  ])
  assert.deepEqual(aggregated, [{
    name: 'helpers.js',
    rawBytes: 300,
    gzipBytes: 80,
    files: ['helpers-12345678.js', 'helpers-abcdefgh.js'],
  }])
})

const budgets = {
  version: 1,
  totalGzipKiB: 10,
  unbudgetedRegressionPercent: 10,
  assetGroups: {
    entry: { label: 'Entry', assets: ['index.js'], maxGzipKiB: 4 },
    canvas: { label: 'Canvas', assets: ['CanvasWorkspace.js', 'CanvasWorkspace.css'], maxGzipKiB: 5 },
  },
  baselineGzipKiB: { 'lazy.js': 1 },
}

test('evaluateBundleBudgets passes explicit groups and checked-in baselines', () => {
  const result = evaluateBundleBudgets([
    { name: 'index-12345678.js', rawBytes: 5000, gzipBytes: 3 * 1024 },
    { name: 'CanvasWorkspace-12345678.js', rawBytes: 5000, gzipBytes: 3 * 1024 },
    { name: 'CanvasWorkspace-12345678.css', rawBytes: 1000, gzipBytes: 1024 },
    { name: 'lazy-12345678.js', rawBytes: 1000, gzipBytes: 1100 },
  ], budgets)

  assert.equal(result.ok, true)
  assert.equal(result.groups.find((group) => group.id === 'canvas').actualBytes, 4 * 1024)
  assert.deepEqual(result.regressions, [])
})

test('evaluateBundleBudgets fails missing assets, hard limits, and >10% regressions', () => {
  const result = evaluateBundleBudgets([
    { name: 'index-12345678.js', rawBytes: 5000, gzipBytes: 5 * 1024 },
    { name: 'CanvasWorkspace-12345678.js', rawBytes: 5000, gzipBytes: 4 * 1024 },
    { name: 'lazy-12345678.js', rawBytes: 1000, gzipBytes: 1127 },
  ], budgets)

  assert.equal(result.ok, false)
  assert.equal(result.total.ok, false)
  assert.equal(result.groups.find((group) => group.id === 'entry').ok, false)
  assert.deepEqual(result.groups.find((group) => group.id === 'canvas').missing, ['CanvasWorkspace.css'])
  assert.equal(result.regressions[0].name, 'lazy.js')
})
