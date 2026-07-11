/** Active Recovery Playbook offered for an exact workflow + signature match. */

import { useState } from 'react'
import { BookOpenCheck, ShieldX } from 'lucide-react'
import { getResolvedLocale, useT } from '../../i18n'
import type { RecoveryPlaybookSummary } from './types'

export function PlaybookMatchCard({
  playbook,
  busy,
  onUse,
  onRetire,
}: {
  playbook: RecoveryPlaybookSummary
  busy: 'use' | 'retire' | null
  onUse: () => void
  onRetire: () => void
}) {
  const { t } = useT()
  const [confirmRetire, setConfirmRetire] = useState(false)
  const lastValidated = playbook.lastValidatedAt
    ? new Date(playbook.lastValidatedAt).toLocaleDateString(getResolvedLocale())
    : t('recoveryDialog.playbook.never')

  return (
    <section className="we-recovery-playbook" data-testid="recovery-playbook-match" aria-labelledby="recovery-playbook-match-title">
      <header className="we-recovery-playbook__header">
        <span className="we-recovery-playbook__icon" aria-hidden="true"><BookOpenCheck size={18} /></span>
        <div>
          <div className="section-kicker">{t('recoveryDialog.playbook.kicker')}</div>
          <strong id="recovery-playbook-match-title">{playbook.title}</strong>
        </div>
        <span className="we-recovery-playbook__version">v{playbook.version}</span>
      </header>
      <p className="helper-text">{playbook.instructionsMarkdown}</p>
      <dl className="we-recovery-playbook__facts">
        <div><dt>{t('recoveryDialog.playbook.successfulUses')}</dt><dd>{playbook.successfulUses}</dd></div>
        <div><dt>{t('recoveryDialog.playbook.lastValidated')}</dt><dd>{lastValidated}</dd></div>
      </dl>
      <p className="we-recovery-playbook__gate">{t('recoveryDialog.playbook.revalidationRequired')}</p>
      {confirmRetire ? (
        <div className="we-recovery-playbook__retire-confirm" data-testid="recovery-playbook-retire-confirm" role="alert">
          <strong>{t('recoveryDialog.playbook.retireConfirmTitle')}</strong>
          <span>{t('recoveryDialog.playbook.retireConfirmBody')}</span>
          <div className="we-recovery-playbook__actions">
            <button type="button" className="command-button" onClick={() => setConfirmRetire(false)} disabled={busy !== null} autoFocus>
              {t('recoveryDialog.playbook.keepActive')}
            </button>
            <button type="button" className="command-button" onClick={onRetire} disabled={busy !== null}>
              <ShieldX size={14} aria-hidden="true" />
              <span>{busy === 'retire' ? t('recoveryDialog.playbook.retiring') : t('recoveryDialog.playbook.confirmRetire')}</span>
            </button>
          </div>
        </div>
      ) : (
      <div className="we-recovery-playbook__actions">
        <button type="button" className="command-button" onClick={() => setConfirmRetire(true)} disabled={busy !== null}>
          <ShieldX size={14} aria-hidden="true" />
          <span>{t('recoveryDialog.playbook.retire')}</span>
        </button>
        <button type="button" className="command-button command-button-primary" onClick={onUse} disabled={busy !== null}>
          <BookOpenCheck size={14} aria-hidden="true" />
          <span>{busy === 'use' ? t('recoveryDialog.playbook.loading') : t('recoveryDialog.playbook.use')}</span>
        </button>
      </div>
      )}
    </section>
  )
}
