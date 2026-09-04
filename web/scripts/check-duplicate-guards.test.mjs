import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { collectDuplicateGuards, duplicateGuardDeclarations } from './check-duplicate-guards.mjs'

test('flags local guard declarations and ignores imports and other names', () => {
  const source = [
    "import { isRecord } from '../lib/guards'",
    'function asRecord(value: unknown) { return null }',
    'export const isRecordish = () => true',
    '  const asRecordOrEmpty = (value: unknown) => ({})',
  ].join('\n')
  assert.deepEqual(duplicateGuardDeclarations(source), [
    { name: 'asRecord', line: 2 },
    { name: 'asRecordOrEmpty', line: 4 },
  ])
})

test('scans production sources and exempts the owner module and tests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janusly-guards-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lib'))
  fs.mkdirSync(path.join(root, 'components'))
  fs.writeFileSync(path.join(root, 'lib', 'guards.ts'), 'export function isRecord() {}')
  fs.writeFileSync(path.join(root, 'components', 'Panel.tsx'), 'function isRecord() {}')
  fs.writeFileSync(path.join(root, 'components', 'Panel.test.tsx'), 'function isRecord() {}')
  assert.deepEqual(collectDuplicateGuards(root).map((v) => `${v.file}:${v.line}`), ['components/Panel.tsx:1'])
})
