import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  collectRawOperationCalls,
  collectRawV1Reads,
  rawOperationCalls,
  rawV1ReadCalls,
  readManifestOperations,
  readV1ReadPaths,
} from './check-raw-v1-reads.mjs'

const contract = `
export const V1_READ_PATHS = {
  recoveryMetrics: "/recovery/metrics",
  recoveryCase: "/recovery/cases/{caseId}",
  workflowHealth: "/workflows/health",
} as const;
`

const operations = readManifestOperations({
  paths: {
    '/workflows/save': { post: {} },
    '/workflows/rollback': { post: {} },
    '/recovery/cases/{caseId}': { get: {} },
    '/recovery/playbooks/{id}/use': { post: {} },
    '/recovery/home': { get: {} },
  },
})

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

test('flags raw mutations and templated paths that are manifest operations, by method', () => {
  const source = [
    "api('/workflows/save', { method: 'POST', body: JSON.stringify(workflow) })",
    "api(`/recovery/playbooks/${encodeURIComponent(id)}/use`, { method: 'POST', body })",
    "api('/v1/recovery/cases/' + id)",
    "api(`/v1/recovery/cases/${encodeURIComponent(id)}`)",
    "api('/recovery/home?scope=impact', { signal })",
    "api('/workflows/save')",
    "api('/recovery/playbooks/match?deadLetterId=x')",
    '// raw-api: probes the legacy alias on purpose',
    "api('/workflows/rollback', { method: 'POST' })",
    "contractApi('POST /workflows/save', '/workflows/save', workflow)",
  ].join('\n')
  assert.deepEqual(rawOperationCalls(source, operations).map(({ line, operation }) => `${line}:${operation}`), [
    '1:POST /workflows/save',
    '2:POST /recovery/playbooks/{id}/use',
    '4:GET /recovery/cases/{caseId}',
    '5:GET /recovery/home',
  ])
})

test('scans production files only, exempts the transport and lib layers, and keeps the baseline shrinking', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janusly-v1-reads-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lib'))
  fs.mkdirSync(path.join(root, 'components'))
  fs.writeFileSync(path.join(root, 'api.ts'), "api('/recovery/metrics')")
  fs.writeFileSync(path.join(root, 'lib', 'x.ts'), "api('/recovery/metrics')")
  fs.writeFileSync(path.join(root, 'components', 'Panel.tsx'), "api('/recovery/metrics')\napi('/workflows/save', { method: 'POST' })")
  fs.writeFileSync(path.join(root, 'components', 'Panel.test.tsx'), "api('/recovery/metrics')")
  const violations = collectRawV1Reads(root, readV1ReadPaths(contract))
  assert.deepEqual(violations.map((v) => v.file), ['components/Panel.tsx'])

  assert.deepEqual(collectRawOperationCalls(root, operations, {}).violations.map((v) => `${v.file}:${v.operation}`),
    ['components/Panel.tsx:POST /workflows/save'])
  const baselined = collectRawOperationCalls(root, operations, { 'components/Panel.tsx': ['POST /workflows/save'] })
  assert.deepEqual([baselined.violations, baselined.stale], [[], []])
  const stale = collectRawOperationCalls(root, operations, { 'components/Gone.tsx': ['POST /workflows/rollback'] })
  assert.deepEqual(stale.stale, [{ file: 'components/Gone.tsx', operation: 'POST /workflows/rollback' }])
})

// Variable paths (`api(path)`) cannot be matched statically; these are the
// call sites that motivated the operation check and must stay typed.
test('keeps the motivating call sites on contractApi', () => {
  const src = new URL('../src/', import.meta.url)
  const read = (file) => fs.readFileSync(new URL(file, src), 'utf8')
  const sites = {
    'hooks/useWorkflowCommands.ts': ["contractApi('POST /workflows/save'"],
    'components/RollbackConfirmDialog.tsx': ["contractApi('POST /workflows/rollback'"],
    'components/recovery-case/useRecoveryCaseController.ts': ["'GET /recovery/cases/{caseId}'"],
    'components/recovery-dialog/useRecoveryDialogController.ts': [
      "contractApi('POST /ai/patch-workflow'", "'POST /recovery/playbooks/{id}/use'", "contractApi('POST /workflows/save'",
    ],
    'components/RecoveryDeltaCard.tsx': ["contractApi('GET /workflows/health/delta'"],
    'components/RecoveryCenterPanel.tsx': ["contractApi('GET /recovery/home', '/recovery/home',", "contractApi('GET /recovery/home', '/recovery/home?scope=impact'"],
  }
  for (const [file, needles] of Object.entries(sites)) {
    const source = read(file)
    for (const needle of needles) assert.ok(source.includes(needle), `${file} must call ${needle}`)
  }
  for (const file of ['components/RollbackConfirmDialog.tsx', 'components/recovery-case/useRecoveryCaseController.ts',
    'components/RecoveryDeltaCard.tsx', 'components/RecoveryCenterPanel.tsx']) {
    assert.doesNotMatch(read(file), /\bapi\(/, `${file} has no raw api() call`)
  }
})
