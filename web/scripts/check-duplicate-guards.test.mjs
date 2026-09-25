import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { collectDuplicateGuards, duplicateGuardDeclarations, ownedGuardNames } from './check-duplicate-guards.mjs'

test('owns the guard-like exports of the real guards module, not its combinators', () => {
  const names = ownedGuardNames(fs.readFileSync(new URL('../src/lib/guards.ts', import.meta.url), 'utf8'))
  for (const name of ['isRecord', 'asRecord', 'asRecordOrEmpty', 'isNonEmptyString', 'isNullableString',
    'isOptionalString', 'isOptionalNullableString', 'isFiniteNumber', 'hasOnlyKeys', 'isShape', 'isString']) {
    assert.ok(names.includes(name), name)
  }
  for (const name of ['literal', 'shape', 'nullable', 'anyOf', 'allOf', 'arrayOf', 'recordOf', 'isAny']) {
    assert.ok(!names.includes(name), name)
  }
})

test('ignores generic combinator names in production code but still flags a guard copy', () => {
  const names = ownedGuardNames(fs.readFileSync(new URL('../src/lib/guards.ts', import.meta.url), 'utf8'))
  const source = ['const shape = {}', 'const literal = 3', 'function isFiniteNumber(value: unknown) { return true }'].join('\n')
  assert.deepEqual(duplicateGuardDeclarations(source, names).map(({ name }) => name), ['isFiniteNumber'])
})

test('flags local guard declarations, including case variants, and ignores imports and other names', () => {
  const source = [
    "import { isRecord } from '../lib/guards'",
    'function asRecord(value: unknown) { return null }',
    'export const isRecordish = () => true',
    '  const asRecordOrEmpty = (value: unknown) => ({})',
    'function isNonemptyString(value: unknown) { return true }',
    'const isFiniteNumber = (value: unknown) => true',
  ].join('\n')
  assert.deepEqual(duplicateGuardDeclarations(source).map(({ name, line }) => ({ name, line })), [
    { name: 'asRecord', line: 2 },
    { name: 'asRecordOrEmpty', line: 4 },
    { name: 'isNonemptyString', line: 5 },
    { name: 'isFiniteNumber', line: 6 },
  ])
  assert.equal(duplicateGuardDeclarations(source)[2].owner, 'isNonEmptyString')
})

test('scans production sources and exempts the owner module and tests', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janusly-guards-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'lib'))
  fs.mkdirSync(path.join(root, 'components'))
  fs.writeFileSync(path.join(root, 'lib', 'guards.ts'), 'export function isRecord() {}\nexport function hasOnlyKeys() {}')
  fs.writeFileSync(path.join(root, 'components', 'Panel.tsx'), 'function isRecord() {}\nconst hasOnlyKeys = () => true')
  fs.writeFileSync(path.join(root, 'components', 'Panel.test.tsx'), 'function isRecord() {}')
  assert.deepEqual(collectDuplicateGuards(root).map((v) => `${v.file}:${v.line}`), ['components/Panel.tsx:1', 'components/Panel.tsx:2'])
})
