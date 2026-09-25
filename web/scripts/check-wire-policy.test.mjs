import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { collectWirePolicyLiterals, WIRE_READERS, wirePolicyLiterals } from './check-wire-policy.mjs'

test('flags numeric literals other than 0, 1 and -1, ignoring comments and strings', () => {
  const source = [
    'const a = value.length > 200',
    'const b = count >= 0 && index === -1 && total === 1',
    "const c = 'page size 50' // cap 64",
    '/* at most 3 */ const d = items[0]',
    'const e = limit <= 4_000 || bytes > 2 ** 10',
  ].join('\n')
  assert.deepEqual(wirePolicyLiterals(source).map(({ line, literal }) => `${line}:${literal}`), [
    '1:200', '5:4_000', '5:2', '5:10',
  ])
})

test('honours same-line and next-line markers, including JSX block comments', () => {
  const source = [
    'const cap = 512 // wire-policy: amplification bound shared with Go',
    '// wire-policy: form bound mirrors the engine',
    'const bound = 5',
    '',
    'const later = 7',
    'const view = (',
    '  <div>',
    '    {/* wire-policy: presentation only */}',
    '    <input min={5} max={50} />',
    '  </div>',
    ')',
  ].join('\n')
  assert.deepEqual(wirePolicyLiterals(source, 'view.tsx').map(({ line, literal }) => `${line}:${literal}`), ['5:7'])
})

test('a standalone marker exempts only the next line', () => {
  const source = [
    '// wire-policy: form bounds mirror the engine',
    'const bounds = [',
    '  [5, 100],',
    ']',
  ].join('\n')
  assert.deepEqual(wirePolicyLiterals(source).map(({ line, literal }) => `${line}:${literal}`), ['3:5', '3:100'])
})

test('requires a reason on every marker', () => {
  const findings = wirePolicyLiterals('const a = 3 // wire-policy:')
  assert.deepEqual(findings.map(({ line, message }) => `${line}:${message}`), ['1:wire-policy marker needs a reason', '1:numeric literal'])
})

test('scans the listed readers and reports file and line', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janusly-wire-policy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'src'))
  fs.writeFileSync(path.join(root, 'src', 'reader.ts'), 'export const ok = (v: number) => v > 0\nexport const bad = (v: number) => v <= 256\n')
  assert.deepEqual(collectWirePolicyLiterals(root, ['src/reader.ts']).map((v) => `${v.file}:${v.line}:${v.literal}`), ['src/reader.ts:2:256'])
})

test('covers every hand-written wire reader of the contract program', () => {
  for (const file of WIRE_READERS) assert.ok(fs.existsSync(new URL(`../${file}`, import.meta.url)), file)
  assert.equal(WIRE_READERS.length, 10)
})
