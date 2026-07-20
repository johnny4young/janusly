import { describe, expect, it } from 'vitest'

import {
  AI_OPERATOR_GUIDANCE_SCOPE_MAX_BYTES,
  containsOperatorGuidanceSecret,
  scrubOperatorGuidanceSecrets,
  summarizeOperatorGuidance,
  truncateUtf8,
} from './operator-guidance'
import { utf8ByteLength } from './utf8'

describe('operator guidance UTF-8 bounds', () => {
  it('counts UTF-8 bytes rather than JavaScript code units', () => {
    expect(utf8ByteLength('é')).toBe(2)
    expect(utf8ByteLength('🧭')).toBe(4)
    expect(AI_OPERATOR_GUIDANCE_SCOPE_MAX_BYTES).toBe(8 * 1024)
  })

  it('truncates at a valid UTF-8 boundary', () => {
    expect(truncateUtf8('ab🧭cd', 6)).toBe('ab🧭')
    expect(truncateUtf8('ab🧭cd', 5)).toBe('ab')
    expect(truncateUtf8('short', 8)).toBe('short')
  })

  it('projects only presence and UTF-8 size for audit metadata', () => {
    expect(summarizeOperatorGuidance('  🧭  ')).toEqual({ configured: true, bytes: 8 })
    expect(summarizeOperatorGuidance('   ')).toEqual({ configured: false, bytes: 3 })
    expect(summarizeOperatorGuidance(null)).toEqual({ configured: false, bytes: 0 })
  })

  it('detects and scrubs embedded tokens, credential URLs, DSNs, and private keys', () => {
    const token = `Prefix sk-ant-${'a'.repeat(24)} suffix`
    const projectToken = `Prefix sk-proj-${'b'.repeat(24)} suffix`
    const dsn = 'Use postgres://user:password@db.internal/app for reads'
    const mysqlDsn = 'Use mysql://user:password@db.internal/app for writes'
    const credentialUrl = 'Fetch https://operator:super-secret@example.com/report'
    const privateKey = 'Key:\n-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----\nNever expose it.'
    expect(containsOperatorGuidanceSecret(token)).toBe(true)
    expect(containsOperatorGuidanceSecret(projectToken)).toBe(true)
    expect(containsOperatorGuidanceSecret(dsn)).toBe(true)
    expect(containsOperatorGuidanceSecret(mysqlDsn)).toBe(true)
    expect(containsOperatorGuidanceSecret(credentialUrl)).toBe(true)
    expect(containsOperatorGuidanceSecret(privateKey)).toBe(true)
    expect(scrubOperatorGuidanceSecrets(`${token}\n${projectToken}\n${dsn}\n${mysqlDsn}\n${credentialUrl}\n${privateKey}`))
      .not.toMatch(/sk-(?:ant|proj)-|postgres:\/\/|mysql:\/\/|operator:super-secret|BEGIN PRIVATE KEY/)
    expect(containsOperatorGuidanceSecret('Prefer bounded retries and explicit approval gates.')).toBe(false)
  })
})
