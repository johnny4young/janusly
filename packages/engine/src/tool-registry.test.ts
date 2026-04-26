import { describe, expect, it } from 'vitest'
import { listTools, validateToolInput, executeTool } from './tool-registry'

describe('tool-registry', () => {
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
})
