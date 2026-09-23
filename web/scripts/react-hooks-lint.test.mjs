import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const webRoot = fileURLToPath(new URL('../', import.meta.url))
const oxlint = fileURLToPath(new URL('../node_modules/.bin/oxlint', import.meta.url))

test('the repository lint configuration rejects a conditional React hook', () => {
  const result = spawnSync(oxlint, ['--format', 'json', 'scripts/fixtures/react-hooks-negative.tsx'], {
    cwd: webRoot,
    encoding: 'utf8',
  })

  assert.ifError(result.error)
  assert.equal(result.status, 1, result.stdout || result.stderr)
  const report = JSON.parse(result.stdout)
  assert.ok(
    report.diagnostics.some(({ code }) => code === 'react-hooks(rules-of-hooks)'),
    `expected react/rules-of-hooks, received ${result.stdout}`,
  )
})
