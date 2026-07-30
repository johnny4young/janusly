import { describe, expect, it } from 'vitest'

import type { ToolInputFieldSchema } from '../types'
import {
  applyToolInputDraft,
  formatToolInputDraft,
  parseToolInputDraft,
} from './tool-input-model'

const fields: ToolInputFieldSchema[] = [
  { name: 'enabled', kind: 'boolean', required: false },
  { name: 'payload', kind: 'json', required: true },
  { name: 'attempts', kind: 'integer', required: false },
  { name: 'title', kind: 'string', required: true },
  { name: 'region', kind: 'string', required: false, options: ['us', 'eu'] },
]

describe('tool-input-model', () => {
  it('parses literals into their registered types', () => {
    expect(parseToolInputDraft(fields[2]!, '12')).toEqual({
      ok: true,
      value: 12,
    })
    expect(parseToolInputDraft(fields[0]!, 'false')).toEqual({
      ok: true,
      value: false,
    })
    expect(parseToolInputDraft(fields[1]!, '{"status":"ready"}')).toEqual({
      ok: true,
      value: { status: 'ready' },
    })
  })

  it('preserves complete template expressions for every runtime-resolved kind', () => {
    for (const field of fields) {
      expect(parseToolInputDraft(field, '{{context.input.value}}')).toEqual({
        ok: true,
        value: '{{context.input.value}}',
      })
    }
  })

  it('rejects malformed typed values and removes blank optional values', () => {
    expect(parseToolInputDraft(fields[2]!, '1.5')).toEqual({ ok: false, error: 'integer' })
    expect(parseToolInputDraft(fields[0]!, 'yes')).toEqual({ ok: false, error: 'boolean' })
    expect(parseToolInputDraft(fields[1]!, '{')).toEqual({ ok: false, error: 'json' })
    expect(parseToolInputDraft(fields[3]!, '')).toEqual({ ok: false, error: 'required' })
    expect(parseToolInputDraft(fields[2]!, '')).toEqual({ ok: true, remove: true })
    expect(parseToolInputDraft(fields[4]!, 'other')).toEqual({ ok: false, error: 'option' })
    expect(parseToolInputDraft(fields[4]!, '{{context.input.region}}')).toEqual({
      ok: true,
      value: '{{context.input.region}}',
    })
  })

  it('patches one known key while preserving advanced fields', () => {
    const parsed = parseToolInputDraft(fields[2]!, '4')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(applyToolInputDraft({ title: 'Demo', futureFlag: true }, fields[2]!, parsed)).toEqual({
      title: 'Demo',
      attempts: 4,
      futureFlag: true,
    })
  })

  it('formats JSON and template drafts without adding destructive quoting', () => {
    expect(formatToolInputDraft({ a: 1 }, 'json')).toBe('{\n  "a": 1\n}')
    expect(formatToolInputDraft('{{item.payload}}', 'json')).toBe('{{item.payload}}')
    expect(formatToolInputDraft(false, 'boolean')).toBe('false')
  })
})
