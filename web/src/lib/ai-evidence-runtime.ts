/** Browser read-time redaction for AI evidence side channels; shape is the generated guard's. */

import type { SuggestionEvidence } from './api-types.generated'
import { scrubSecretShapes } from './error-signature'

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
// Display bounds: the scrub truncates to these, and a longer response is never rejected.
export const MAX_EVIDENCE_ROWS = 24 // wire-policy: display bound, same value as aievidence.MaxEvidenceRows
export const MAX_SNIPPET_CHARS = 400 // wire-policy: display bound, same value as aievidence.MaxSnippetChars
export const MAX_LABEL_CHARS = 120 // wire-policy: display bound, same value as aievidence.MaxLabelChars
export const MAX_SOURCE_REF_CHARS = 200 // wire-policy: display bound, same value as aievidence.MaxSourceRefChars

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

/** Re-scrub guarded evidence rows at read time; counts, lengths and weight ranges are the server's. */
export function parseEvidenceRows(rows: readonly SuggestionEvidence[]): EvidenceRow[] | null {
  const out: EvidenceRow[] = []
  for (const row of rows) {
    // EvidencePanel labels each chip with the kind it translates.
    if (!EVIDENCE_KINDS.includes(row.kind as EvidenceKind)) return null
    const scrubbed = scrubEvidenceRow({ ...row, kind: row.kind as EvidenceKind })
    // Each chip renders a snippet and the source token the operator traces back.
    if (!scrubbed.snippet || !scrubbed.sourceRef) return null
    out.push(scrubbed)
  }
  return out
}
