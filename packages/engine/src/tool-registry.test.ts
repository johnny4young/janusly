import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./http-policy', () => ({
  consumeStreamToPreview: vi.fn(),
  fetchHttpTarget: vi.fn(),
}))

import { consumeStreamToPreview, fetchHttpTarget } from './http-policy'
import { listPlannerTools, listTools, validateToolInput, executeTool, isToolWriteSide } from './tool-registry'

const fetchHttpTargetMock = vi.mocked(fetchHttpTarget)
const consumeStreamToPreviewMock = vi.mocked(consumeStreamToPreview)

describe('tool-registry', () => {
  beforeEach(() => {
    fetchHttpTargetMock.mockReset()
    consumeStreamToPreviewMock.mockReset()
  })

  it('listTools exposes the registered schemas', () => {
    const names = listTools().map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining(['http.request', 'text.uppercase', 'json.parse', 'json.pick', 'db.schema.describe', 'db.query.read', 'db.query.write', 'db.query.transaction', 'vector.search', 'vector.upsert']))
  })

  it('validateToolInput rejects unknown tools', () => {
    const result = validateToolInput('unknown.tool', { foo: 'bar' })
    expect(result.valid).toBe(false)
    expect(result.issues).toContain('Unknown tool: unknown.tool')
  })

  it('validateToolInput flags missing required fields', () => {
    const result = validateToolInput('text.uppercase', {})
    expect(result.valid).toBe(false)
    expect(result.issues).toContain('Missing required input: value')
  })

  it('validateToolInput treats empty required strings as missing', () => {
    expect(validateToolInput('text.uppercase', { value: '' })).toEqual({
      valid: false,
      issues: ['Missing required input: value'],
    })
    expect(validateToolInput('json.pick', { path: '' })).toEqual({
      valid: false,
      issues: ['Missing required input: path'],
    })
    expect(validateToolInput('http.request', { url: '' })).toEqual({
      valid: false,
      issues: ['Missing required input: url'],
    })
  })

  it('validateToolInput accepts valid inputs', () => {
    expect(validateToolInput('text.uppercase', { value: 'hi' })).toEqual({ valid: true, issues: [] })
  })

  it('executeTool runs text.uppercase end-to-end', async () => {
    const result = await executeTool('text.uppercase', { value: 'hola' }, {})
    expect(result).toEqual({ value: 'HOLA' })
  })

  it('executeTool fails for an unknown tool', async () => {
    await expect(executeTool('does.not.exist', {}, {})).rejects.toThrow('Unknown tool')
  })

  it('executeTool propagates input validation errors', async () => {
    await expect(executeTool('text.uppercase', {}, {})).rejects.toThrow('Missing required input')
  })

  it('json.pick reads from context when no source is provided', async () => {
    const result = await executeTool('json.pick', { path: 'http.output.statusCode' }, { http: { output: { statusCode: 201 } } })
    expect(result).toEqual({ value: 201 })
  })

  it('validateToolInput rejects wrong-typed inputs with a typed message', () => {
    const result = validateToolInput('text.uppercase', { value: 42 })
    expect(result.valid).toBe(false)
    expect(result.issues.some(issue => issue.includes('Invalid type for value'))).toBe(true)
  })

  it('executeTool throws when input fails the schema', async () => {
    await expect(executeTool('text.uppercase', { value: 42 }, {})).rejects.toThrow(/Invalid tool input/)
  })

  it('executeTool returns parsed output that matches the declared shape', async () => {
    const result = await executeTool('json.pick', { path: 'x.y' }, { x: { y: 7 } })
    expect(result).toEqual({ value: 7 })
  })

  it('http.request exposes parsed JSON only for a declared JSON media type', async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: '{"id":42}',
      headers: { 'content-type': 'application/json; charset=utf-8' },
    })
    expect(await executeTool('http.request', { url: 'https://example.com/customer' }, {})).toEqual({
      statusCode: 200,
      ok: true,
      body: '{"id":42}',
      json: { id: 42 },
    })

    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: '{"id":42}',
      headers: { 'content-type': 'text/plain' },
    })
    expect(await executeTool('http.request', { url: 'https://example.com/plain' }, {})).not.toHaveProperty('json')
  })

  it('executeTool rejects outputs that do not match the declared schema', async () => {
    // statusCode is `z.number()` in the output schema; a string here forces
    // the validator to reject so the test exercises the executor->validator
    // boundary even with the post-refactor HttpResult shape.
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: '200' as unknown as number,
      ok: true,
      body: 'ok',
      headers: {},
    })

    await expect(
      executeTool('http.request', { url: 'https://example.com' }, {}),
    ).rejects.toThrow('Tool http.request returned invalid output')
  })

  it('executeTool consumes streamed http.request output into a schema-safe preview', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('preview'))
        controller.close()
      },
    })
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: stream,
      headers: {},
    } as never)
    consumeStreamToPreviewMock.mockResolvedValueOnce({
      preview: 'preview',
      originalBytes: 7,
      truncated: false,
    })

    const result = await executeTool('http.request', {
      url: 'https://example.com/file.csv',
      bodyMode: 'stream',
      streamPreviewBytes: 8_192,
    }, {})

    expect(fetchHttpTargetMock).toHaveBeenCalledWith(
      'https://example.com/file.csv',
      expect.objectContaining({ bodyMode: 'stream' }),
    )
    expect(consumeStreamToPreviewMock).toHaveBeenCalledWith(stream, 8_192)
    expect(result).toEqual({
      statusCode: 200,
      ok: true,
      body: 'preview',
      streamed: true,
      streamedBytes: 7,
      streamTruncated: false,
    })
  })

  it('isToolWriteSide flags http.request and ignores read-side tools', () => {
    expect(isToolWriteSide('http.request')).toBe(true)
    expect(isToolWriteSide('db.query.write')).toBe(true)
    expect(isToolWriteSide('db.query.transaction')).toBe(true)
    expect(isToolWriteSide('db.query.read')).toBe(false)
    expect(isToolWriteSide('db.schema.describe')).toBe(false)
    expect(isToolWriteSide('vector.upsert')).toBe(true)
    expect(isToolWriteSide('vector.search')).toBe(false)
    expect(isToolWriteSide('text.uppercase')).toBe(false)
    expect(isToolWriteSide('json.pick')).toBe(false)
    expect(isToolWriteSide('time.now')).toBe(false)
    expect(isToolWriteSide('does.not.exist')).toBe(false)
  })

  it('listTools derives required and optional from each input schema', () => {
    const tools = listTools()
    const http = tools.find(tool => tool.name === 'http.request')
    expect(http?.required).toEqual(['url'])
    expect(http?.optional?.slice().sort()).toEqual([
      'body',
      'bodyMode',
      'headers',
      'maxRedirects',
      'maxResponseBytes',
      'method',
      'streamPreviewBytes',
      'timeoutMs',
    ])
    const textUpper = tools.find(tool => tool.name === 'text.uppercase')
    expect(textUpper?.required).toEqual(['value'])
    expect(textUpper?.optional).toBeUndefined()
    expect(textUpper?.inputFields).toEqual([
      { name: 'value', kind: 'string', required: true },
    ])
    expect(textUpper?.writeSide).toBe(false)
    expect(http?.writeSide).toBe(true)
    expect(http?.inputFields).toEqual(expect.arrayContaining([
      { name: 'url', kind: 'string', required: true },
      { name: 'headers', kind: 'json', required: false },
      { name: 'maxResponseBytes', kind: 'integer', required: false },
      { name: 'bodyMode', kind: 'string', required: false, options: ['buffer', 'stream'] },
    ]))
    const dbRead = tools.find(tool => tool.name === 'db.query.read')
    expect(dbRead?.required).toEqual(['credential', 'sql'])
    expect(dbRead?.optional?.slice().sort()).toEqual(['maxRows', 'params', 'timeoutMs'])
    const vectorSearch = tools.find(tool => tool.name === 'vector.search')
    expect(vectorSearch?.required).toEqual(['query'])
    expect(vectorSearch?.optional).toEqual(['topK'])
    const vectorUpsert = tools.find(tool => tool.name === 'vector.upsert')
    expect(vectorUpsert?.required).toEqual(['content'])
    expect(vectorUpsert?.optional).toEqual(['metadata'])
  })

  it('derives a typed planner catalog and omits write-side tools in dry-run mode', () => {
    const publicTools = listTools()
    const plannerTools = listPlannerTools()
    expect(plannerTools).toHaveLength(publicTools.length)

    const http = plannerTools.find(tool => tool.name === 'http.request')
    expect(http).toMatchObject({ writeSide: true })
    expect(http?.inputSchema).toMatchObject({
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string' },
        method: { type: 'string' },
      },
    })

    const dryRunTools = listPlannerTools({ dryRun: true })
    expect(dryRunTools.every(tool => !tool.writeSide)).toBe(true)
    expect(dryRunTools.map(tool => tool.name)).toEqual(expect.arrayContaining([
      'db.query.read',
      'json.parse',
      'text.uppercase',
      'vector.search',
    ]))
    expect(dryRunTools.map(tool => tool.name)).not.toEqual(expect.arrayContaining([
      'db.query.write',
      'email.send',
      'http.request',
      'vector.upsert',
    ]))

    // The web-facing contract stays compact: it exposes bounded field
    // descriptors, never the planner-only JSON Schema.
    expect(publicTools[0]).not.toHaveProperty('inputSchema')
    expect(typeof publicTools[0]?.writeSide).toBe('boolean')
    expect(publicTools.every(tool => Array.isArray(tool.inputFields))).toBe(true)
    for (const tool of publicTools) {
      const catalogKeys = [...(tool.required ?? []), ...(tool.optional ?? [])].sort()
      const requiredOrder = [...tool.inputFields]
        .sort((left, right) => Number(right.required) - Number(left.required))
        .map(field => field.required)
      expect(tool.inputFields.map(field => field.name).sort(), tool.name).toEqual(catalogKeys)
      expect(tool.inputFields.map(field => field.required), tool.name).toEqual(requiredOrder)
      for (const field of tool.inputFields) {
        expect(field.required, `${tool.name}.${field.name}`).toBe(tool.required?.includes(field.name) ?? false)
        if (field.options) expect(field.options.length, `${tool.name}.${field.name}`).toBeGreaterThan(0)
      }
    }
  })

  /* -------- text.* -------- */

  it('text.lowercase happy path + Zod rejection', async () => {
    expect(await executeTool('text.lowercase', { value: 'HELLO' }, {})).toEqual({ value: 'hello' })
    expect(validateToolInput('text.lowercase', {}).issues).toContain('Missing required input: value')
  })

  it('text.trim happy path + Zod rejection', async () => {
    expect(await executeTool('text.trim', { value: '  hi\n' }, {})).toEqual({ value: 'hi' })
    expect(validateToolInput('text.trim', {}).issues).toContain('Missing required input: value')
  })

  it('text.replace defaults to replace-all and respects all:false', async () => {
    expect(await executeTool('text.replace', { value: 'a.b.c', search: '.', replacement: '_' }, {})).toEqual({ value: 'a_b_c' })
    expect(await executeTool('text.replace', { value: 'a.b.c', search: '.', replacement: '_', all: false }, {})).toEqual({ value: 'a_b.c' })
    const issues = validateToolInput('text.replace', { value: 'x' }).issues
    expect(issues).toContain('Missing required input: search')
    expect(issues).toContain('Missing required input: replacement')
  })

  it('text.regex returns matches and honors capture groups', async () => {
    expect(await executeTool('text.regex', { value: 'a1 b2 c3', pattern: '[a-z]\\d', flags: 'g' }, {})).toEqual({
      matches: ['a1', 'b2', 'c3'],
    })
    expect(await executeTool('text.regex', { value: 'user@example.com', pattern: '([^@]+)@(.+)', group: 1 }, {})).toEqual({
      matches: ['user'],
    })
    expect(validateToolInput('text.regex', { value: 'x' }).issues).toContain('Missing required input: pattern')
  })

  it('text.regex uses RE2 syntax and rejects unsafe RegExp-only features', async () => {
    const backreference = validateToolInput('text.regex', {
      value: 'catcat',
      pattern: '(cat)\\1',
    })
    expect(backreference.valid).toBe(false)
    expect(backreference.issues.join('\n')).toMatch(/invalid perl operator|invalid escape sequence|invalid regex/i)

    const lookahead = validateToolInput('text.regex', {
      value: 'abcdef',
      pattern: 'abc(?=def)',
    })
    expect(lookahead.valid).toBe(false)
    expect(lookahead.issues.join('\n')).toMatch(/invalid perl operator|invalid regex/i)
  })

  it('text.regex normalizes unicode mode and rejects unsupported flags', async () => {
    expect(await executeTool('text.regex', { value: 'A1 a2', pattern: '[a-z]\\d', flags: 'gi' }, {})).toEqual({
      matches: ['A1', 'a2'],
    })
    const unsupported = validateToolInput('text.regex', { value: 'x', pattern: 'x', flags: 'd' })
    expect(unsupported.valid).toBe(false)
    expect(unsupported.issues.join('\n')).toContain('Unsupported regular expression flags')
  })

  /* -------- json.* -------- */

  it('json.parse returns native JSON values and rejects invalid text without echoing it', async () => {
    expect(await executeTool('json.parse', { value: '{"customer":{"id":42}}' }, {})).toEqual({
      value: { customer: { id: 42 } },
    })
    expect(await executeTool('json.parse', { value: 'true' }, {})).toEqual({ value: true })
    expect(await executeTool('json.parse', { value: 'null' }, {})).toEqual({ value: null })
    expect(validateToolInput('json.parse', {}).issues).toContain('Missing required input: value')
    const error = await executeTool('json.parse', { value: 'secret-body {' }, {}).catch(value => value)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('json.parse received invalid JSON')
    expect((error as Error).message).not.toContain('secret-body')
  })

  it('json.set returns a copy with the path set, leaving the source untouched', async () => {
    const source = { user: { id: 1 } }
    const result = await executeTool('json.set', { source, path: 'user.name', value: 'Ada' }, {})
    expect(result).toEqual({ value: { user: { id: 1, name: 'Ada' } } })
    expect(source).toEqual({ user: { id: 1 } }) // immutability check
    expect(validateToolInput('json.set', {}).issues).toContain('Missing required input: path')
  })

  it('json.merge deep-merges objects with b winning on key conflicts', async () => {
    const a = { user: { id: 1, role: 'editor' }, status: 'active' }
    const b = { user: { name: 'Ada', role: 'admin' } }
    const result = await executeTool('json.merge', { a, b }, {})
    expect(result).toEqual({ value: { user: { id: 1, role: 'admin', name: 'Ada' }, status: 'active' } })
    expect(a).toEqual({ user: { id: 1, role: 'editor' }, status: 'active' }) // immutability check
    expect(validateToolInput('json.merge', { a: {} }).issues.some(issue => issue.includes('b'))).toBe(true)
  })

  it('json.set refuses prototype-targeting path segments', async () => {
    await expect(executeTool('json.set', { source: {}, path: '__proto__.polluted', value: 'x' }, {})).rejects.toThrow(/prototype-targeting/)
    await expect(executeTool('json.set', { source: {}, path: 'a.constructor.b', value: 'x' }, {})).rejects.toThrow(/prototype-targeting/)
    // Sanity check: the global Object.prototype is unaffected even after a rejected attempt.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('json.merge skips prototype-targeting keys when present as own properties on b', async () => {
    // JSON.parse produces an own-property "__proto__" (unlike object literals where __proto__ is the prototype setter).
    const b = JSON.parse('{"__proto__":{"polluted":"yes"},"name":"Ada"}') as Record<string, unknown>
    const result = await executeTool('json.merge', { a: {}, b }, {})
    expect(result.value).toEqual({ name: 'Ada' })
    expect((result.value as Record<string, unknown>).polluted).toBeUndefined()
  })

  it('json.jq runs a safe selector subset and validates query syntax', async () => {
    const source = { users: [{ email: 'a@example.com' }, { email: 'b@example.com' }] }
    expect(await executeTool('json.jq', { source, query: '.users[] | .email' }, {})).toEqual({
      value: ['a@example.com', 'b@example.com'],
    })
    expect(await executeTool('json.jq', { query: '.current.user' }, { current: { user: 'Ada' } })).toEqual({
      value: 'Ada',
    })
    const invalid = validateToolInput('json.jq', { query: 'users[]' })
    expect(invalid.valid).toBe(false)
    expect(invalid.issues.join('\n')).toContain('must start with')
  })

  /* -------- csv.* -------- */

  it('csv.parse returns object rows by default', async () => {
    expect(await executeTool('csv.parse', { value: 'a,b\n1,2' }, {})).toEqual({
      rows: [{ a: '1', b: '2' }],
    })
    expect(validateToolInput('csv.parse', {}).issues).toContain('Missing required input: value')
  })

  it('csv.stringify round-trips through csv.parse', async () => {
    const parsed = (await executeTool('csv.parse', { value: 'a,b\n1,2\n3,4' }, {})).rows as Array<Record<string, string>>
    const stringified = await executeTool('csv.stringify', { rows: parsed, header: ['a', 'b'] }, {})
    expect(stringified).toEqual({ value: 'a,b\n1,2\n3,4' })
    expect(validateToolInput('csv.stringify', {}).issues.some(issue => issue.includes('rows'))).toBe(true)
  })

  it('csv.stringify rejects row/header shape mismatches before execution', async () => {
    const objectRowsWithoutHeader = validateToolInput('csv.stringify', { rows: [{ a: '1' }] })
    expect(objectRowsWithoutHeader.valid).toBe(false)
    expect(objectRowsWithoutHeader.issues.join('\n')).toContain('header is required')
    await expect(executeTool('csv.stringify', { rows: [{ a: '1' }] }, {})).rejects.toThrow(/header is required/)

    const arrayRowsWithHeader = validateToolInput('csv.stringify', { rows: [['1']], header: ['a'] })
    expect(arrayRowsWithHeader.valid).toBe(false)
    expect(arrayRowsWithHeader.issues.join('\n')).toContain('header is only valid')
  })

  it('csv.filter keeps rows matching every where entry', async () => {
    const result = await executeTool(
      'csv.filter',
      {
        rows: [{ id: '1', s: 'open' }, { id: '2', s: 'closed' }, { id: '3', s: 'open' }],
        where: { s: 'open' },
      },
      {},
    )
    expect(result).toEqual({ rows: [{ id: '1', s: 'open' }, { id: '3', s: 'open' }] })
    expect(validateToolInput('csv.filter', { rows: [] }).issues.some(issue => issue.includes('where'))).toBe(true)
  })

  /* -------- time.* -------- */

  it('time.now returns ISO + epoch ms in lockstep', async () => {
    const result = await executeTool('time.now', {}, {})
    expect(typeof result.iso).toBe('string')
    expect(typeof result.epochMs).toBe('number')
    expect(new Date(result.iso as string).getTime()).toBe(result.epochMs)
  })

  it('time.parse accepts ISO strings and numeric epochs', async () => {
    expect(await executeTool('time.parse', { value: '2026-01-01T00:00:00Z' }, {})).toEqual({
      iso: '2026-01-01T00:00:00.000Z',
      epochMs: Date.parse('2026-01-01T00:00:00Z'),
    })
    expect(await executeTool('time.parse', { value: 0 }, {})).toEqual({
      iso: '1970-01-01T00:00:00.000Z',
      epochMs: 0,
    })
    // Union-typed required inputs produce "value: Invalid input" rather than the
    // legacy "Missing required input" wording (which is reserved for plain
    // required strings/objects via the formatIssue heuristic).
    const invalid = validateToolInput('time.parse', {})
    expect(invalid.valid).toBe(false)
    expect(invalid.issues.join('\n')).toContain('value')
  })

  it('time.format honors the closed-enum format set', async () => {
    expect(await executeTool('time.format', { value: '2026-01-01T00:00:00Z', format: 'iso' }, {})).toEqual({
      value: '2026-01-01T00:00:00.000Z',
    })
    expect(await executeTool('time.format', { value: '2026-01-01T00:00:00Z', format: 'epoch' }, {})).toEqual({
      value: Date.parse('2026-01-01T00:00:00Z'),
    })
    expect(await executeTool('time.format', { value: '2026-01-01T00:00:00Z', format: 'epochSeconds' }, {})).toEqual({
      value: Math.trunc(Date.parse('2026-01-01T00:00:00Z') / 1000),
    })
    const invalid = validateToolInput('time.format', { value: '2026-01-01T00:00:00Z', format: 'pretty' })
    expect(invalid.valid).toBe(false)
  })

  it('time.diff computes b - a in the requested unit (default ms)', async () => {
    expect(
      await executeTool(
        'time.diff',
        { a: '2026-01-01T00:00:00Z', b: '2026-01-04T00:00:00Z', unit: 'd' },
        {},
      ),
    ).toEqual({ value: 3 })
    expect(
      await executeTool('time.diff', { a: 0, b: 1500 }, {}),
    ).toEqual({ value: 1500 })
    const invalid = validateToolInput('time.diff', {})
    expect(invalid.valid).toBe(false)
    expect(invalid.issues.some(issue => issue.includes('a'))).toBe(true)
  })

  it('time.add applies an ISO 8601 duration', async () => {
    const result = await executeTool('time.add', { value: '2026-01-01T00:00:00Z', duration: 'P3D' }, {})
    expect(result).toEqual({
      iso: '2026-01-04T00:00:00.000Z',
      epochMs: Date.parse('2026-01-04T00:00:00Z'),
    })
    await expect(executeTool('time.add', { value: '2026-01-01T00:00:00Z', duration: 'oops' }, {})).rejects.toThrow(/Invalid ISO 8601 duration/)
    expect(validateToolInput('time.add', { value: '2026-01-01T00:00:00Z' }).issues).toContain('Missing required input: duration')
  })

  /* -------- crypto.* -------- */

  it('crypto.sha256 returns the hex digest of the value', async () => {
    expect(await executeTool('crypto.sha256', { value: 'hello' }, {})).toEqual({
      digest: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    })
    expect(validateToolInput('crypto.sha256', {}).issues).toContain('Missing required input: value')
  })

  it('crypto.hmac defaults to sha256 and supports sha512', async () => {
    const sha256 = await executeTool('crypto.hmac', { value: 'hello', secret: 'topsecret' }, {})
    expect(sha256.digest).toMatch(/^[0-9a-f]{64}$/)
    const sha512 = await executeTool('crypto.hmac', { value: 'hello', secret: 'topsecret', algorithm: 'sha512' }, {})
    expect(sha512.digest).toMatch(/^[0-9a-f]{128}$/)
    expect(validateToolInput('crypto.hmac', { value: 'x' }).issues).toContain('Missing required input: secret')
  })

  it('crypto.uuid emits a v4 UUID', async () => {
    const result = await executeTool('crypto.uuid', {}, {})
    expect(result.value).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  it('listTools exposes every text/json/csv/time/crypto tool', () => {
    const names = listTools().map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'text.lowercase', 'text.trim', 'text.replace', 'text.regex',
      'json.parse', 'json.set', 'json.merge', 'json.jq',
      'csv.parse', 'csv.stringify', 'csv.filter', 'csv.fetch',
      'time.now', 'time.parse', 'time.format', 'time.diff', 'time.add',
      'crypto.sha256', 'crypto.hmac', 'crypto.uuid',
    ]))
  })

  it('csv.fetch streams a CSV URL and returns a bounded summary', async () => {
    // Happy path: a small 3-row CSV streams through, the tool returns
    // the bounded summary with counts + sample. The mock body is a real
    // ReadableStream so `streamCsvSummary` exercises its actual reader
    // path — only the SSRF / network primitive is mocked.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('id,status\n1,ACTIVE\n2,ACTIVE\n3,inactive'))
        controller.close()
      },
    })
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: stream,
      headers: {},
    } as never)

    const result = await executeTool('csv.fetch', {
      url: 'https://example.com/data.csv',
      sampleRows: 10,
    }, {}) as Record<string, unknown>

    expect(fetchHttpTargetMock).toHaveBeenCalledWith(
      'https://example.com/data.csv',
      expect.objectContaining({ bodyMode: 'stream' }),
    )
    expect(result.ok).toBe(true)
    expect(result.statusCode).toBe(200)
    expect(result.totalRows).toBe(3)
    expect(result.matchedRows).toBe(3)
    expect(result.headers).toEqual(['id', 'status'])
    expect(result.streamTruncated).toBe(false)
    expect((result.sampleRows as unknown[]).length).toBe(3)
  })

  it('csv.fetch includes an error when a non-2xx response still streams', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('code,message\nE_LIMIT,too many rows'))
        controller.close()
      },
    })
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 503,
      ok: false,
      body: stream,
      headers: {},
    } as never)

    const result = await executeTool('csv.fetch', {
      url: 'https://example.com/data.csv',
      sampleRows: 10,
    }, {}) as Record<string, unknown>

    expect(result.ok).toBe(false)
    expect(result.statusCode).toBe(503)
    expect(result.error).toBe('HTTP 503')
    expect(result.totalRows).toBe(1)
    expect(result.sampleRows).toEqual([{ code: 'E_LIMIT', message: 'too many rows' }])
  })

  it('csv.fetch surfaces streamTruncated:true with partial sample when the stream aborts mid-flight', async () => {
    // Simulate a byte-cap abort by streaming a few good chunks then
    // erroring the controller. The tool should NOT throw — the partial
    // summary rides through with `ok: false, streamTruncated: true`.
    let i = 0
    const chunks = ['id,name\n', '1,alice\n', '2,bob\n']
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(new TextEncoder().encode(chunks[i]))
          i += 1
          return
        }
        controller.error(new Error('response body exceeded maxBytes (10485760)'))
      },
    })
    fetchHttpTargetMock.mockResolvedValueOnce({
      statusCode: 200,
      ok: true,
      body: stream,
      headers: {},
    } as never)

    const result = await executeTool('csv.fetch', {
      url: 'https://example.com/large.csv',
      sampleRows: 10,
    }, {}) as Record<string, unknown>

    expect(result.ok).toBe(false)
    expect(result.streamTruncated).toBe(true)
    expect((result.error as string)).toMatch(/maxBytes/)
    expect(result.totalRows).toBe(2)             // both rows arrived before abort
    expect((result.sampleRows as unknown[]).length).toBe(2)
  })

  it('csv.fetch returns ok:false statusCode:0 when fetchHttpTarget rejects pre-stream (SSRF / DNS)', async () => {
    // The shared `fetchHttpTarget` chokepoint throws synchronously when
    // the URL fails the SSRF guard or DNS pinning — the stream is never
    // opened. The tool catches and returns a uniform envelope so
    // downstream `condition` nodes can branch on `.ok` without knowing
    // which guard fired.
    fetchHttpTargetMock.mockRejectedValueOnce(new Error('private target blocked: 169.254.169.254 Bearer secret_token_1234567890'))

    const result = await executeTool('csv.fetch', {
      url: 'http://169.254.169.254/secrets.csv',
      sampleRows: 10,
    }, {}) as Record<string, unknown>

    expect(result.ok).toBe(false)
    expect(result.statusCode).toBe(0)
    expect((result.error as string)).toMatch(/private/)
    expect((result.error as string)).not.toContain('secret_token')
    expect((result.error as string)).toContain('[redacted]')
    expect(result.streamedBytes).toBe(0)
    expect((result.sampleRows as unknown[]).length).toBe(0)
    expect(result.headers).toEqual([])
  })
})
