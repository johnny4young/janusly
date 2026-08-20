/**
 * Failure-recovery dialog — "Why this suggestion?" evidence panel.
 *
 * Used by: web/src/components/RecoveryDialog.tsx (via ReviewBody).
 * Owns the collapsible evidence list: one chip per row grouped visually by
 * `kind`, each with its `sourceRef` deep-link token, plus the render-time
 * re-scrub (defense in depth on top of the API's read-time scrub).
 */

import { useMemo } from 'react'
import { scrubEvidenceRow, type EvidenceRow } from '@/lib/ai-evidence'
import { useT } from '../../i18n'
import { evidenceKindLabel } from './recovery-dialog-model'

/**
 * Collapsible "Why this suggestion?" panel. Renders one chip per evidence
 * row, grouped visually by `kind` via a `data-evidence-kind` attribute the
 * CSS colours. Each row's `sourceRef` is shown as a monospace deep-link
 * token (run id, recovery item id, memory entry id, tool name, signature
 * category) so the operator can trace the suggestion back to its source.
 *
 * Defense in depth: every row re-passes through the shared `scrubEvidenceRow`
 * at render time even though the API already scrubbed at read time — the
 * AC's "scrubbed at read even though scrubbed at write" applies on the
 * browser side too. An empty list hides the panel entirely.
 */
export function EvidencePanel({ evidence }: { evidence: readonly EvidenceRow[] }) {
  const { t } = useT()
  // Re-scrub at render (cheap, idempotent) and drop any row that scrubbed
  // down to an empty snippet. Memoized so a re-render of the tabpanel (e.g.
  // switching suggestion tabs) doesn't re-walk the list each time.
  const rows = useMemo(
    () => evidence.map((row) => scrubEvidenceRow(row)).filter((row) => row.snippet.length > 0),
    [evidence],
  )
  if (rows.length === 0) return null
  return (
    <details className="we-recovery-evidence">
      <summary className="we-recovery-evidence__summary">
        {t('recoveryDialog.evidence.summary', { count: rows.length })}
      </summary>
      <ul className="we-recovery-evidence__list">
        {rows.map((row, index) => (
          <li
            key={`${row.kind}:${row.sourceRef}:${index}`}
            className="we-recovery-evidence__row"
            data-evidence-kind={row.kind}
          >
            <span className="we-recovery-evidence__kind">{row.label || evidenceKindLabel(row.kind)}</span>
            <span className="we-recovery-evidence__snippet">{row.snippet}</span>
            <code className="we-recovery-evidence__ref" title={t('recoveryDialog.evidence.sourceRefTitle')}>
              {row.sourceRef}
            </code>
          </li>
        ))}
      </ul>
    </details>
  )
}
