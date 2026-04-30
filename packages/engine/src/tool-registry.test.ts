import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./http-policy', () => ({
  fetchHttpTarget: vi.fn(),
}))

import { fetchHttpTarget } from './http-policy'
import { listTools, validateToolInput, executeTool } from './tool-registry'

const fetchHttpTargetMock = vi.mocked(fetchHttpTarget)

describe('tool-registry', () => {
  beforeEach(() => {
    fetchHttpTargetMock.mockReset()
  })

  it('listTools exposes the registered schemas', () => {
    const names = listTools().map(tool => tool.name)
    expect(names).toEqual(expect.arrayContaining(['http.request', 'text.uppercase', 'json.pick']))
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

  it('executeTool rejects outputs that do not match the declared schema', async () => {
    fetchHttpTargetMock.mockResolvedValueOnce({
      status: '200',
      ok: true,
      text: async () => 'ok',
    } as never)

    await expect(
      executeTool('http.request', { url: 'https://example.com' }, {}),
    ).rejects.toThrow('Tool http.request returned invalid output')
  })

  it('listTools derives required and optional from each input schema', () => {
    const tools = listTools()
    const http = tools.find(tool => tool.name === 'http.request')
    expect(http?.required).toEqual(['url'])
    expect(http?.optional?.slice().sort()).toEqual(['body', 'headers', 'method'])
    const textUpper = tools.find(tool => tool.name === 'text.uppercase')
    expect(textUpper?.required).toEqual(['value'])
    expect(textUpper?.optional).toBeUndefined()
  })
})
