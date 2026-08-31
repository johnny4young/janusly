/**
 * Truthful first-run entry into Recovery Lab. A fresh workspace stays empty
 * until the operator explicitly starts a controlled drill or builds a flow.
 */

import {
  FileSearch,
  FlaskConical,
  PlayCircle,
  ShieldCheck,
  Sparkles,
  Workflow,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useT } from '../../i18n'

export function RecoveryLabEntry({
  onOpenStudio,
  onOpenRecipes,
  onStartDrill,
  onDismiss,
}: {
  onOpenStudio: () => void
  onOpenRecipes: () => void
  onStartDrill?: () => void | Promise<void>
  onDismiss?: () => void
}) {
  const { t } = useT()
  return (
    <section
      className="we-recovery-lab-entry"
      aria-labelledby="we-recovery-lab-entry-title"
      data-testid="recovery-lab-entry"
    >
      {onDismiss && (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="we-recovery-lab-entry__dismiss"
          onClick={onDismiss}
          aria-label={t('recoveryCenter.labEntry.dismiss')}
          data-testid="recovery-lab-entry-dismiss"
        >
          <X size={14} aria-hidden="true" />
        </Button>
      )}
      <div className="we-recovery-lab-entry__copy">
        <div className="section-kicker">{t('recoveryCenter.labEntry.kicker')}</div>
        <h2 id="we-recovery-lab-entry-title">{t('recoveryCenter.labEntry.title')}</h2>
        <p>{t('recoveryCenter.labEntry.body')}</p>
        <div className="we-recovery-lab-entry__notice" role="note">
          <ShieldCheck size={15} aria-hidden="true" />
          <span>{t('recoveryCenter.labEntry.notice')}</span>
        </div>
        <div className="we-recovery-lab-entry__actions">
          {onStartDrill && (
            <Button
              variant="primary"
              type="button"
              onClick={() => void onStartDrill()}
              data-testid="recovery-center-empty-cta-drill"
            >
              <PlayCircle size={14} aria-hidden="true" />
              <span>{t('recoveryCenter.labEntry.cta.drill')}</span>
            </Button>
          )}
          <Button
            type="button"
            variant={onStartDrill ? 'secondary' : 'primary'}
            onClick={onOpenStudio}
            data-testid="recovery-center-empty-cta-studio"
          >
            <Sparkles size={14} aria-hidden="true" />
            <span>{t('recoveryCenter.labEntry.cta.studio')}</span>
          </Button>
          <Button
            variant="secondary"
            type="button"
            onClick={onOpenRecipes}
            data-testid="recovery-center-empty-cta-recipes"
          >
            <Workflow size={14} aria-hidden="true" />
            <span>{t('recoveryCenter.labEntry.cta.recipes')}</span>
          </Button>
        </div>
      </div>

      <ol className="we-recovery-lab-entry__steps">
        <li>
          <FlaskConical size={16} aria-hidden="true" />
          <div>
            <strong>{t('recoveryCenter.labEntry.step1.title')}</strong>
            <span>{t('recoveryCenter.labEntry.step1.body')}</span>
          </div>
        </li>
        <li>
          <FileSearch size={16} aria-hidden="true" />
          <div>
            <strong>{t('recoveryCenter.labEntry.step2.title')}</strong>
            <span>{t('recoveryCenter.labEntry.step2.body')}</span>
          </div>
        </li>
        <li>
          <ShieldCheck size={16} aria-hidden="true" />
          <div>
            <strong>{t('recoveryCenter.labEntry.step3.title')}</strong>
            <span>{t('recoveryCenter.labEntry.step3.body')}</span>
          </div>
        </li>
      </ol>
    </section>
  )
}
