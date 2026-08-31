import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  collectLegacyUiOwners,
  isLegacyUiClass,
  legacyUiViolations,
} from './check-ui-legacy.mjs'

test('recognizes only the frozen form and action namespaces', () => {
  assert.equal(isLegacyUiClass('text-field'), true)
  assert.equal(isLegacyUiClass('text-field--error'), true)
  assert.equal(isLegacyUiClass('command-button-primary'), true)
  assert.equal(isLegacyUiClass('we-btn--ghost'), true)
  assert.equal(isLegacyUiClass('we-field'), true)
  assert.equal(isLegacyUiClass('we-field__unrelated-layout'), false)
  assert.equal(isLegacyUiClass('ui-button'), false)
})

test('collects production JSX owners but ignores tests and unrelated literals', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'janusly-ui-legacy-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'Panel.tsx'), `
    const endpoint = '/text-field'
    export const Panel = () => <button className="command-button command-button-primary">Save</button>
  `)
  fs.writeFileSync(path.join(root, 'Panel.test.tsx'), '<div className="text-field" />')

  assert.deepEqual(collectLegacyUiOwners(root), {
    'Panel.tsx': ['command-button', 'command-button-primary'],
  })
})

test('rejects every legacy production reference without an allowance list', () => {
  assert.deepEqual(
    legacyUiViolations({ 'Panel.tsx': ['command-button', 'text-field'] }),
    [
      'legacy class .command-button in Panel.tsx',
      'legacy class .text-field in Panel.tsx',
    ],
  )
  assert.deepEqual(legacyUiViolations({}), [])
})
