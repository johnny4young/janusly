import assert from 'node:assert/strict'
import test from 'node:test'

import {
  frontCodeCatalogKeys,
  packCatalogValues,
  projectCompactCatalog,
  selectCatalogNamespace,
} from './compact-i18n-plugin.mjs'

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
  assert.equal(
    frontCodeCatalogKeys(['app.title', 'common.save']),
    '@app.title\0@common.save',
  )
  assert.equal(
    frontCodeCatalogKeys(['recovery.title', 'recovery.timeline']),
    '@recovery.title\0Kmeline',
  )
})

test('front-coded catalog keys do not collide with prefix code units', () => {
  const longPrefix = 'recoveryCenter.validation.controlledDrill.'
  const encoded = frontCodeCatalogKeys([
    `${longPrefix}description`,
    `${longPrefix}details`,
  ])

  assert.equal(encoded.split('\0').length, 2)
  assert.throws(
    () => frontCodeCatalogKeys(['invalid\0key']),
    /cannot contain null characters/,
  )
})

test('catalog namespaces form a complete, non-overlapping partition', () => {
  const catalog = {
    'app.title': 'Janusly',
    'recoveryCenter.title': 'Recovery',
    'rightPanel.workflows.title': 'Workflows',
    'operations.title': 'Settings',
    'operations.brief.semanticCase.title': 'Diagnose an outcome incident',
  }
  const core = selectCatalogNamespace(catalog, 'core')
  const workspace = selectCatalogNamespace(catalog, 'workspace')

  assert.deepEqual(Object.keys(core), [
    'app.title',
    'recoveryCenter.title',
    'operations.brief.semanticCase.title',
  ])
  assert.deepEqual(Object.keys(workspace), ['rightPanel.workflows.title', 'operations.title'])
  assert.deepEqual(
    new Set([...Object.keys(core), ...Object.keys(workspace)]),
    new Set(Object.keys(catalog)),
  )
})

test('catalog values use a collision-safe packed projection', () => {
  assert.equal(packCatalogValues(['Save', 'Line one\nLine two']), 'Save\0Line one\nLine two')
  assert.throws(
    () => packCatalogValues(['invalid\0value']),
    /cannot contain null characters/,
  )
})

test('compact catalog projection rejects consistency drift and non-string values', () => {
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
