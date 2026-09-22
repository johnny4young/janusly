/** Browser runtime guard and redaction for AI evidence side channels. */

import { scrubSecretShapes } from './error-signature'
import { isRecord } from './guards'

export const EVIDENCE_KINDS = [
  'recovery_feedback',
  'memory_entry',
  'runbook_excerpt',
  'recent_error',
  'signature_rule',
  'tool_contract',
  'recovery_playbook',
] as const

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]
export const MAX_EVIDENCE_ROWS = 24
export const MAX_SNIPPET_CHARS = 400
export const MAX_LABEL_CHARS = 120
export const MAX_SOURCE_REF_CHARS = 200

export type EvidenceRow = {
  kind: EvidenceKind
  sourceRef: string
  snippet: string
  label?: string
  weight?: number
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g

function clampLine(value: string, maxChars: number): string {
  const oneLine = scrubSecretShapes(value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim())
  return oneLine.length <= maxChars ? oneLine : `${oneLine.slice(0, maxChars - 1).trimEnd()}…`
}

export function scrubEvidenceRow(row: EvidenceRow): EvidenceRow {
  const scrubbed: EvidenceRow = {
    kind: row.kind,
    sourceRef: clampLine(row.sourceRef, MAX_SOURCE_REF_CHARS),
    snippet: clampLine(row.snippet, MAX_SNIPPET_CHARS),
  }
  if (row.label) scrubbed.label = clampLine(row.label, MAX_LABEL_CHARS)
  if (typeof row.weight === 'number' && Number.isFinite(row.weight)) {
    scrubbed.weight = Math.max(0, Math.min(1, row.weight))
  }
  return scrubbed
}

export function scrubEvidenceRows(rows: readonly EvidenceRow[]): EvidenceRow[] {
  const out: EvidenceRow[] = []
  for (const row of rows) {
    if (out.length >= MAX_EVIDENCE_ROWS) break
    const scrubbed = scrubEvidenceRow(row)
    if (scrubbed.snippet) out.push(scrubbed)
  }
  return out
}

/** Validate, re-scrub and bound an untrusted evidence list at the HTTP boundary. */
export function parseEvidenceRows(value: unknown): EvidenceRow[] | null {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_ROWS) return null
  for (const row of value) {
    if (!isRecord(row)
      || typeof row.kind !== 'string' || !EVIDENCE_KINDS.includes(row.kind as EvidenceKind)
      || typeof row.sourceRef !== 'string' || row.sourceRef.length > MAX_SOURCE_REF_CHARS
      || typeof row.snippet !== 'string' || row.snippet.length > MAX_SNIPPET_CHARS
      || row.label !== undefined && (typeof row.label !== 'string' || row.label.length > MAX_LABEL_CHARS)
      || row.weight !== undefined && (typeof row.weight !== 'number' || !Number.isFinite(row.weight)
        || row.weight < 0 || row.weight > 1)) return null
  }
  const rows = scrubEvidenceRows(value as EvidenceRow[])
  return rows.length === value.length && rows.every((row) => row.sourceRef.length > 0) ? rows : null
}
