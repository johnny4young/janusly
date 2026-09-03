/** Collapsible operator-facing summaries of alternatives the patch model rejected. */

import { useMemo } from 'react'

import { useT } from '../../i18n'
import { normalizeConsideredAlternatives } from './recovery-dialog-model'

export function AlternativeHypothesesPanel({ alternatives }: { alternatives: unknown }) {
  const { t } = useT()
  const rows = useMemo(() => normalizeConsideredAlternatives(alternatives), [alternatives])
  if (rows.length === 0) return null

  return (
    <details className="we-recovery-hypotheses" data-testid="recovery-hypotheses">
      <summary className="we-recovery-hypotheses__summary">
        {t('recoveryDialog.hypotheses.summary', { count: rows.length })}
      </summary>
      <p className="helper-text">{t('recoveryDialog.hypotheses.description')}</p>
      <ul className="we-recovery-hypotheses__list">
        {rows.map((row, index) => (
          <li key={`${row.approach}:${index}`} className="we-recovery-hypotheses__row">
            <strong>{row.approach}</strong>
            <span>{row.rejectedBecause}</span>
          </li>
        ))}
      </ul>
    </details>
  )
}
