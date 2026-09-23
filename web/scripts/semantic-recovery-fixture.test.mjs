import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createSemanticRecoveryFixture } from '../e2e/_helpers/semantic-recovery-fixture.ts'

test('semantic fixture reports the real HTTP status when seeding fails', async (context) => {
  const previousFetch = globalThis.fetch
  context.after(() => { globalThis.fetch = previousFetch })
  globalThis.fetch = async () => new Response('seed unavailable', { status: 503 })

  await assert.rejects(
    createSemanticRecoveryFixture('en', { apiUrl: 'http://127.0.0.1:1' }),
    /POST \/start returned 503: seed unavailable/,
  )
})
