/**
 * AI evidence side-channel contract — the structured list of context items
 * the prompt composer fed into an AI suggestion. Surfaced verbatim on the
 * `/ai/patch-workflow`, `/ai/explain-run`, and `/ai/suggest-improvement`
 * responses as `evidence: EvidenceRow[]` so the operator can see WHAT the
 * model used to derive a suggestion ("Why this suggestion?").
 *
 * This module is the single source of truth for the shape AND the read-time
 * redaction pass. It lives in `src/lib` (zero runtime deps beyond
 * `zod`) so both the API (writer) and the web bundle (renderer, via the
 * `@/lib/ai-evidence` subpath) import the same contract — a
 * field rename is one PR, two consumers.
 *
 * Used by:
 *  - `internal/aievidence` — assembles the rows from the same
 *    context sources the route already loaded (feedback summary, recalled
 *    memory entries, runbook excerpt, recent similar errors, the fired
 *    signature-normalization rule, per-tool inputContract), runs every
 *    rendered string through `scrubEvidenceRow`, and bounds the list.
 *  - `web/src/components/RecoveryDialog.tsx` — renders the collapsible
 *    "Why this suggestion?" panel with one chip per row, deep-linking by
 *    `sourceRef` (run id, recovery item id, memory entry id, tool name).
 *
 * Invariants:
 *  - **No second LLM call.** Evidence is a deterministic projection of the
 *    context the composer already gathered — it is emitted as a structured
 *    side-channel, never re-derived by asking the model.
 *  - **Redaction at read.** Every `snippet` (and the `label`) re-passes
 *    through `scrubSecretShapes` here even though the upstream sources were
 *    already scrubbed at write time (the `safePersistPayload` key-redaction
 *    + the per-source scrubbers). Defense in depth: the snippet is the last
 *    free-form string that reaches the operator's browser.
 *  - **Never cross-org.** The assembler reads ONLY org-scoped rows the route
 *    already gated to `auth.orgId`; this module enforces the shape, not the
 *    tenancy (that stays in the SQL predicates upstream).
 *  - **Empty is valid.** A response with `evidence: []` is a normal response
 *    (memory disabled, no past feedback, no runbook, cold-start recovery).
 *    The renderer hides the panel entirely when the list is empty.
 *  - **Bounded.** `MAX_EVIDENCE_ROWS` caps the count and `MAX_SNIPPET_CHARS`
 *    caps each snippet so the response stays small and the panel stays
 *    scannable.
 */

import * as z from 'zod/mini'

import { scrubSecretShapes } from './error-signature'

/**
 * Closed enum of evidence source kinds. Each maps to a distinct chip style
 * + deep-link affordance in the recovery dialog. Adding a kind means a new
 * entry here + a new branch in the web renderer's `evidenceKindLabel`.
 *
 *  - `recovery_feedback` — a past operator accept/reject decision for this
 *    workflow's approach (the operator → system loop). `sourceRef` is the
 *    `approachLabel`; no single-row id (the summary is an aggregation).
 *  - `memory_entry` — a recalled `memory_entries` row (only when the org has
 *    memory enabled). `sourceRef` is the memory entry id.
 *  - `runbook_excerpt` — an excerpt of the workflow's `workflow_metadata`
 *    runbook Markdown. `sourceRef` is the workflow id.
 *  - `recent_error` — a recent similar failure signature on this run/workflow.
 *    `sourceRef` is the run id (or dead-letter id) the sample came from.
 *  - `signature_rule` — the error-signature normalization rule that fired for
 *    the failing node. `sourceRef` is the rule `category`.
 *  - `tool_contract` — the failing tool's registered input contract (required
 *    / optional field names). `sourceRef` is the tool name.
 *  - `recovery_playbook` — a manually promoted, evidence-gated recovery
 *    procedure. `sourceRef` is the playbook id.
 */
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

/** Hard cap on the number of evidence rows returned. Keeps the panel
 *  scannable and the response payload small. */
export const MAX_EVIDENCE_ROWS = 24

/** Hard cap on each rendered snippet. Long source strings get a trailing `…`. */
export const MAX_SNIPPET_CHARS = 400

/** Hard cap on the human-readable label. */
export const MAX_LABEL_CHARS = 120

/** Hard cap on the deep-link reference. Source ids are short; this guards
 *  against a malformed value bloating the payload. */
export const MAX_SOURCE_REF_CHARS = 200

/**
 * One row of evidence. `kind` selects the chip style + link affordance;
 * `sourceRef` is the deep-link target (run id, recovery item id, memory
 * entry id, tool name, or signature category — interpreted per `kind`);
 * `snippet` is the operator-facing one-line summary; `weight` is an optional
 * 0-1 relevance hint (e.g. memory cosine similarity) the renderer can show
 * as a subtle bar.
 */
export const EvidenceRowSchema = /* @__PURE__ */ z.object({
  kind: z.enum(EVIDENCE_KINDS),
  sourceRef: z.string().check(z.maxLength(MAX_SOURCE_REF_CHARS)),
  snippet: z.string().check(z.maxLength(MAX_SNIPPET_CHARS)),
  /** Optional human label for the chip (e.g. "Past feedback", "Runbook").
   *  When absent the renderer derives a label from `kind`. */
  label: z.optional(z.string().check(z.maxLength(MAX_LABEL_CHARS))),
  /** Optional relevance weight in [0, 1]. Higher = more relevant. */
  weight: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
})

export type EvidenceRow = z.infer<typeof EvidenceRowSchema>

/** The response envelope's evidence list. Always present (possibly empty)
 *  on the three extended AI routes. */
export const EvidenceListSchema = /* @__PURE__ */ z.array(EvidenceRowSchema).check(z.maxLength(MAX_EVIDENCE_ROWS))

// Control characters (NUL, newlines, tabs, DEL) — the cheapest way for a
// hostile snippet to break the panel layout. Stripped to spaces before the
// whitespace-run collapse. Declared with explicit \u escapes so no raw
// control bytes live in source.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]+/g

function clampLine(value: string, maxChars: number): string {
  // Collapse control chars + whitespace runs so the snippet is a clean
  // single line, then re-scrub for secret shapes (defense in depth) and cap.
  const oneLine = scrubSecretShapes(value.replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim())
  if (oneLine.length <= maxChars) return oneLine
  return `${oneLine.slice(0, maxChars - 1).trimEnd()}…`
}

/**
 * Read-time redaction + bounding for a single evidence row. Re-applies
 * `scrubSecretShapes` to `snippet` and `label`, caps every string field,
 * and clamps `weight` into [0, 1]. Pure — no I/O.
 *
 * The AC requires the scrub to run "at read time even though they were
 * scrubbed at write time", so this is called both when assembling the rows
 * in the API and (idempotently) on any row that survives a cache.
 */
export function scrubEvidenceRow(row: EvidenceRow): EvidenceRow {
  const scrubbed: EvidenceRow = {
    kind: row.kind,
    sourceRef: clampLine(row.sourceRef, MAX_SOURCE_REF_CHARS),
    snippet: clampLine(row.snippet, MAX_SNIPPET_CHARS),
  }
  if (typeof row.label === 'string' && row.label.length > 0) {
    scrubbed.label = clampLine(row.label, MAX_LABEL_CHARS)
  }
  if (typeof row.weight === 'number' && Number.isFinite(row.weight)) {
    scrubbed.weight = Math.max(0, Math.min(1, row.weight))
  }
  return scrubbed
}

/**
 * Scrub + bound a full evidence list. Caps the count at `MAX_EVIDENCE_ROWS`
 * and drops rows whose `snippet` scrubbed down to empty (a row with no
 * content is noise in the panel). Order is preserved — the assembler is
 * responsible for ranking before calling this.
 */
export function scrubEvidenceRows(rows: readonly EvidenceRow[]): EvidenceRow[] {
  const out: EvidenceRow[] = []
  for (const row of rows) {
    if (out.length >= MAX_EVIDENCE_ROWS) break
    const scrubbed = scrubEvidenceRow(row)
    if (scrubbed.snippet.length === 0) continue
    out.push(scrubbed)
  }
  return out
}
