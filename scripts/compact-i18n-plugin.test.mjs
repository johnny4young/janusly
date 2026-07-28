import assert from 'node:assert/strict'
import test from 'node:test'

import { projectCompactCatalog } from './compact-i18n-plugin.mjs'

test('compact catalog projection shares canonical keys and preserves locale values', () => {
  const canonical = { 'app.title': 'Janusly', 'common.save': 'Save' }
  const translated = { 'common.save': 'Guardar', 'app.title': 'Janusly' }

  assert.deepEqual(projectCompactCatalog(canonical, translated, 'keys'), [
    'app.title',
    'common.save',
  ])
  assert.deepEqual(projectCompactCatalog(canonical, translated, 'values'), [
    'Janusly',
    'Guardar',
  ])
})

test('compact catalog projection rejects parity drift and non-string values', () => {
  assert.throws(
    () => projectCompactCatalog(
      { 'app.title': 'Janusly' },
      { 'common.save': 'Save' },
      'values',
      'es',
    ),
    /missing: app\.title; extra: common\.save/,
  )
  assert.throws(
    () => projectCompactCatalog(
      { 'app.title': 'Janusly' },
      { 'app.title': 42 },
      'values',
      'es',
    ),
    /es:app\.title must be a string/,
  )
})
