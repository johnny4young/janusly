/**
 * Failure-recovery dialog — "Why this suggestion?" evidence panel.
 *
 * Used by: web/src/components/RecoveryDialog.tsx (via ReviewBody).
 * Owns the collapsible evidence list: one chip per row grouped visually by
 * `kind`, each with its validated `sourceRef` deep-link token.
 */

import type { EvidenceRow } from '@/lib/ai-evidence-runtime'
import { useT } from '../../i18n'
import { evidenceKindLabel } from './recovery-dialog-model'
import './recovery-dialog.css'

/**
 * Collapsible "Why this suggestion?" panel. Renders one chip per evidence
 * row, grouped visually by `kind` via a `data-evidence-kind` attribute the
 * CSS colours. Each row's `sourceRef` is shown as a monospace deep-link
 * token (run id, recovery item id, memory entry id, tool name, signature
 * category) so the operator can trace the suggestion back to its source.
 *
 * Rows have already passed the untrusted HTTP-boundary parser, including
 * read-time redaction and bounds. An empty list hides the panel entirely.
 */
export function EvidencePanel({ evidence }: { evidence: readonly EvidenceRow[] }) {
  const { t } = useT()
  if (evidence.length === 0) return null
  return (
    <details className="we-recovery-evidence">
      <summary className="we-recovery-evidence__summary">
        {t('recoveryDialog.evidence.summary', { count: evidence.length })}
      </summary>
      <ul className="we-recovery-evidence__list">
        {evidence.map((row, index) => (
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
