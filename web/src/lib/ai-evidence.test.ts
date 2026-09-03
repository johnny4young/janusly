import { describe, expect, it } from 'vitest'

import {
  EvidenceRowSchema,
  EvidenceListSchema,
  MAX_EVIDENCE_ROWS,
  MAX_SNIPPET_CHARS,
  scrubEvidenceRow,
  scrubEvidenceRows,
  type EvidenceRow,
} from './ai-evidence'

describe('ai-evidence shape', () => {
  it('validates a minimal row', () => {
    const parsed = EvidenceRowSchema.safeParse({
      kind: 'signature_rule',
      sourceRef: 'http_error',
      snippet: 'HTTP 401 on http node',
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown kind', () => {
    const parsed = EvidenceRowSchema.safeParse({ kind: 'mystery', sourceRef: 'x', snippet: 'y' })
    expect(parsed.success).toBe(false)
  })

  it('accepts an empty evidence list (empty is valid)', () => {
    const parsed = EvidenceListSchema.safeParse([])
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data).toEqual([])
  })
})

describe('scrubEvidenceRow — redaction at read', () => {
  it('redacts an OpenAI-shaped secret in the snippet', () => {
    const row: EvidenceRow = {
      kind: 'recent_error',
      sourceRef: 'run-1',
      snippet: 'auth failed for sk-abcdefghijklmnopqrstuvwxyz012345 on call',
    }
    const scrubbed = scrubEvidenceRow(row)
    expect(scrubbed.snippet).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345')
    expect(scrubbed.snippet).toContain('[redacted]')
  })

  it('redacts a Bearer token in the label', () => {
    const row: EvidenceRow = {
      kind: 'tool_contract',
      sourceRef: 'github.create_issue',
      snippet: 'fields',
      label: 'Authorization: Bearer abcdef0123456789abcdef',
    }
    const scrubbed = scrubEvidenceRow(row)
    expect(scrubbed.label).not.toContain('Bearer abcdef0123456789abcdef')
    expect(scrubbed.label).toContain('[redacted]')
  })

  it('collapses control characters to a single line', () => {
    const row: EvidenceRow = {
      kind: 'runbook_excerpt',
      sourceRef: 'wf-1',
      snippet: 'line one\n\tline two\r\nline three',
    }
    const scrubbed = scrubEvidenceRow(row)
    expect(scrubbed.snippet).toBe('line one line two line three')
  })

  it('caps an over-long snippet at MAX_SNIPPET_CHARS with an ellipsis', () => {
    const row: EvidenceRow = {
      kind: 'runbook_excerpt',
      sourceRef: 'wf-1',
      snippet: 'a'.repeat(MAX_SNIPPET_CHARS + 200),
    }
    const scrubbed = scrubEvidenceRow(row)
    expect(scrubbed.snippet.length).toBeLessThanOrEqual(MAX_SNIPPET_CHARS)
    expect(scrubbed.snippet.endsWith('…')).toBe(true)
  })

  it('clamps weight into [0, 1]', () => {
    expect(scrubEvidenceRow({ kind: 'memory_entry', sourceRef: 'm1', snippet: 's', weight: 1.7 }).weight).toBe(1)
    expect(scrubEvidenceRow({ kind: 'memory_entry', sourceRef: 'm1', snippet: 's', weight: -0.3 }).weight).toBe(0)
    expect(scrubEvidenceRow({ kind: 'memory_entry', sourceRef: 'm1', snippet: 's', weight: 0.42 }).weight).toBe(0.42)
  })

  it('drops a non-finite weight', () => {
    const scrubbed = scrubEvidenceRow({ kind: 'memory_entry', sourceRef: 'm1', snippet: 's', weight: Number.NaN })
    expect(scrubbed.weight).toBeUndefined()
  })
})

describe('scrubEvidenceRows — list bounding', () => {
  it('caps the list at MAX_EVIDENCE_ROWS', () => {
    const rows: EvidenceRow[] = Array.from({ length: MAX_EVIDENCE_ROWS + 10 }, (_, i) => ({
      kind: 'recent_error' as const,
      sourceRef: `run-${i}`,
      snippet: `failure ${i}`,
    }))
    expect(scrubEvidenceRows(rows)).toHaveLength(MAX_EVIDENCE_ROWS)
  })

  it('drops rows whose snippet scrubbed to empty', () => {
    const rows: EvidenceRow[] = [
      { kind: 'recent_error', sourceRef: 'run-1', snippet: '   ' },
      { kind: 'signature_rule', sourceRef: 'http_error', snippet: 'HTTP 500' },
    ]
    const out = scrubEvidenceRows(rows)
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('signature_rule')
  })

  it('preserves order', () => {
    const rows: EvidenceRow[] = [
      { kind: 'signature_rule', sourceRef: 'a', snippet: 'first' },
      { kind: 'recovery_feedback', sourceRef: 'b', snippet: 'second' },
      { kind: 'memory_entry', sourceRef: 'c', snippet: 'third' },
    ]
    expect(scrubEvidenceRows(rows).map((r) => r.snippet)).toEqual(['first', 'second', 'third'])
  })
})
