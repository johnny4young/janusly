import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBundleReport, kib } from './bundle-report.mjs'

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
