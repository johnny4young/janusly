import { afterEach, describe, expect, it, vi } from 'vitest'
import { SENSITIVE_KEY_PATTERN, safePersistPayload } from './safe-persist'

describe('safePersistPayload', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('redacts string occurrences of redactedValues recursively', () => {
    const payload = {
      message: 'used token sk-leaky-key-abc to call upstream',
      nested: ['ok', 'sk-leaky-key-abc', { again: 'sk-leaky-key-abc tail' }],
    }
    expect(safePersistPayload(payload, { redactedValues: ['sk-leaky-key-abc'] })).toEqual({
      message: 'used token [redacted] to call upstream',
      nested: ['ok', '[redacted]', { again: '[redacted] tail' }],
    })
  })

  it('redacts sensitive keys regardless of value content (whole-key match, case-insensitive)', () => {
    // The closed regex matches exact keys plus separator/camel-case suffixes.
    // That catches common payload shapes like `secretKey`, `password_hash`,
    // and `tokenValue` without matching lowercase words such as `tokenizer`.
    const payload = {
      Authorization: 'Bearer abc-123',
      headers: { 'x-api-key': 'sk-xxx', normal: 1 },
      payload: {
        secret: 'sx',
        secretKey: 'sk-secret',
        token: 'abc',
        tokenValue: 'tok-secret',
        nested: { password: 'p', password_hash: 'hashed-secret' },
      },
      apiKey: 'sk-camel',
      tokenizer: 'not-a-secret-substring-match',
      keep: 'visible',
    }
    expect(safePersistPayload(payload)).toEqual({
      Authorization: '[redacted]',
      headers: { 'x-api-key': '[redacted]', normal: 1 },
      payload: {
        secret: '[redacted]',
        secretKey: '[redacted]',
        token: '[redacted]',
        tokenValue: '[redacted]',
        nested: { password: '[redacted]', password_hash: '[redacted]' },
      },
      apiKey: '[redacted]',
      tokenizer: 'not-a-secret-substring-match',
      keep: 'visible',
    })
  })

  it('truncates payloads whose serialized JSON exceeds the cap', () => {
    // Build a payload whose JSON definitely exceeds 1 KB so the cap fires.
    const big = { values: Array.from({ length: 200 }, (_, i) => ({ id: i, label: `entry-${i}-with-some-padding` })) }
    const result = safePersistPayload(big, { maxBytes: 1_024 }) as Record<string, unknown>
    expect(result.__truncated).toBe(true)
    expect(typeof result.originalBytes).toBe('number')
    expect(result.maxBytes).toBe(1_024)
    expect(typeof result.preview).toBe('string')
    expect((result.preview as string).startsWith('{"values":[')).toBe(true)
    expect((result.originalBytes as number)).toBeGreaterThan(1_024)
  })

  it('reports truncation size as UTF-8 bytes, not JavaScript string length', () => {
    const payload = { message: '🔐'.repeat(20) }
    const json = JSON.stringify(payload)
    const result = safePersistPayload(payload, { maxBytes: 40 }) as Record<string, unknown>

    expect(result.__truncated).toBe(true)
    expect(result.originalBytes).toBe(Buffer.byteLength(json, 'utf8'))
    expect(result.originalBytes).toBeGreaterThan(json.length)
    expect(Buffer.byteLength(result.preview as string, 'utf8')).toBeLessThanOrEqual(20)
  })

  it('per-call maxBytes override raises the runtime default and keeps the payload whole', () => {
    const big = { values: Array.from({ length: 200 }, (_, i) => `entry-${i}`) }
    // Same payload that the truncation test exceeds at 1 KB now fits at 1 MB.
    const result = safePersistPayload(big, { maxBytes: 1_000_000 }) as { values: string[] }
    expect(Array.isArray(result.values)).toBe(true)
    expect(result.values.length).toBe(200)
  })

  it('JANUSLY_PERSIST_MAX_BYTES env raises the default cap', () => {
    const big = { v: 'x'.repeat(2_000) }
    // At default 256 KB this fits. Force a smaller env-driven cap and assert
    // truncation; then reset and assert it fits.
    vi.stubEnv('JANUSLY_PERSIST_MAX_BYTES', '500')
    const tight = safePersistPayload(big) as Record<string, unknown>
    expect(tight.__truncated).toBe(true)

    vi.unstubAllEnvs()
    const loose = safePersistPayload(big) as { v: string }
    expect(loose.v.length).toBe(2_000)
  })

  it('passes through top-level undefined that JSON.stringify cannot represent', () => {
    // `JSON.stringify(undefined)` returns the string `undefined` (not a JSON
    // string), so the size-measurement step must skip without truncating.
    expect(safePersistPayload(undefined)).toBeUndefined()
  })

  it('normalizes non-JSON runtime values before persistence', () => {
    const error = new Error('failed with context')
    ;(error as Error & { cause?: unknown }).cause = { retryAfterMs: 100n }
    const circular: Record<string, unknown> = { id: 'cycle' }
    circular.self = circular

    expect(safePersistPayload({
      count: 123n,
      error,
      circular,
      omitMe: () => 'not-json',
    })).toMatchObject({
      count: '123',
      error: {
        name: 'Error',
        message: 'failed with context',
        cause: { retryAfterMs: '100' },
      },
      circular: { id: 'cycle', self: '[circular]' },
    })
  })

  it('SENSITIVE_KEY_PATTERN matches the documented closed key set without false positives', () => {
    // Whole-key match — no substring false positives like `tokenizer`.
    for (const key of ['secret', 'SecretKey', 'SECRET_KEY', 'passwordHash', 'PASSWORD_HASH', 'tokenValue', 'TOKEN_VALUE', 'Authorization', 'Cookie', 'x-api-key', 'api_key', 'apiKey', 'client_secret', 'clientSecret', 'private-key', 'privateKey']) {
      expect(SENSITIVE_KEY_PATTERN.test(key)).toBe(true)
    }
    for (const key of ['tokenizer', 'not-a-secret', 'bearer', 'auth', 'normal', '']) {
      expect(SENSITIVE_KEY_PATTERN.test(key)).toBe(false)
    }
  })

  it('returns primitives unchanged when no options apply', () => {
    expect(safePersistPayload(42)).toBe(42)
    expect(safePersistPayload('hello')).toBe('hello')
    expect(safePersistPayload(null)).toBeNull()
    expect(safePersistPayload(true)).toBe(true)
  })

  it('substitutes a stream sentinel when a ReadableStream leaks into the payload', () => {
    // Defense-in-depth: the streaming-mode HTTP executor always pre-consumes
    // the body into a preview before returning, but if a regression let a
    // live stream escape, the persistence chokepoint must NOT try to JSON
    // it (would either throw or write garbage). The sentinel keeps the
    // sibling keys intact so the operator still sees the rest of the
    // executor output.
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.close() } })
    const payload = {
      statusCode: 200,
      ok: true,
      body: stream,
      streamed: true,
    }
    const result = safePersistPayload(payload) as Record<string, unknown>
    expect(result.statusCode).toBe(200)
    expect(result.ok).toBe(true)
    expect(result.streamed).toBe(true)
    expect(result.body).toEqual({
      __stream: true,
      note: expect.stringContaining('ReadableStream not persisted'),
    })
  })
})
