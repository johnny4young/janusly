/**
 * Authoritative Zod schemas for the AI evidence side-channel contract.
 * Browser recovery code imports `ai-evidence-runtime` so schema machinery is
 * not retained in the on-demand dialog chunk; both layers share these exact
 * constants and the manual `EvidenceRow` type.
 */

import * as z from 'zod/mini'
import {
  EVIDENCE_KINDS,
  MAX_EVIDENCE_ROWS,
  MAX_LABEL_CHARS,
  MAX_SNIPPET_CHARS,
  MAX_SOURCE_REF_CHARS,
} from './ai-evidence-runtime'

export {
  EVIDENCE_KINDS,
  MAX_EVIDENCE_ROWS,
  MAX_LABEL_CHARS,
  MAX_SNIPPET_CHARS,
  MAX_SOURCE_REF_CHARS,
  parseEvidenceRows,
  scrubEvidenceRow,
  scrubEvidenceRows,
} from './ai-evidence-runtime'
export type { EvidenceKind, EvidenceRow } from './ai-evidence-runtime'

export const EvidenceRowSchema = /* @__PURE__ */ z.object({
  kind: z.enum(EVIDENCE_KINDS),
  sourceRef: z.string().check(z.maxLength(MAX_SOURCE_REF_CHARS)),
  snippet: z.string().check(z.maxLength(MAX_SNIPPET_CHARS)),
  label: z.optional(z.string().check(z.maxLength(MAX_LABEL_CHARS))),
  weight: z.optional(z.number().check(z.minimum(0), z.maximum(1))),
})

export const EvidenceListSchema = /* @__PURE__ */ z.array(EvidenceRowSchema).check(z.maxLength(MAX_EVIDENCE_ROWS))
