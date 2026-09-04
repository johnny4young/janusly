import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { collectRawV1Reads, rawV1ReadCalls, readV1ReadPaths } from './check-raw-v1-reads.mjs'

const contract = `
export const V1_READ_PATHS = {
  recoveryMetrics: "/recovery/metrics",
  recoveryCase: "/recovery/cases/{caseId}",
  workflowHealth: "/workflows/health",
} as const;
`

test('reads the contract paths out of the TypeScript source', () => {
  assert.deepEqual(readV1ReadPaths(contract), ['/recovery/metrics', '/recovery/cases/{caseId}', '/workflows/health'])
})

test('flags raw api() calls on contract paths, with or without a query string', () => {
  const paths = readV1ReadPaths(contract)
  const source = [
    "api('/recovery/metrics')",
    "api(`/workflows/health?workflowId=${encodeURIComponent(id)}`)",
    "api(`/recovery/cases/${encodeURIComponent(caseId)}`)",
    "api('/dlq')",
    "contractApi('GET /recovery/metrics', '/recovery/metrics', undefined)",
  ].join('\n')
  const findings = rawV1ReadCalls(source, paths)
  assert.deepEqual(findings.map((f) => f.line), [1, 2, 3])
})

test('scans production files only and exempts the transport and lib layers', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janusly-v1-reads-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lib'))
  fs.mkdirSync(path.join(root, 'components'))
  fs.writeFileSync(path.join(root, 'api.ts'), "api('/recovery/metrics')")
  fs.writeFileSync(path.join(root, 'lib', 'x.ts'), "api('/recovery/metrics')")
  fs.writeFileSync(path.join(root, 'components', 'Panel.tsx'), "api('/recovery/metrics')")
  fs.writeFileSync(path.join(root, 'components', 'Panel.test.tsx'), "api('/recovery/metrics')")
  const violations = collectRawV1Reads(root, readV1ReadPaths(contract))
  assert.deepEqual(violations.map((v) => v.file), ['components/Panel.tsx'])
})
