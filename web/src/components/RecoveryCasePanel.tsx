import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Clock3,
  ExternalLink,
  History,
  ShieldAlert,
} from 'lucide-react'
import { useT } from '../i18n'
import type { RecoveryCase } from '../types'
import { EmptyView, PanelChrome } from './panel-primitives'
import { Button } from './ui/Button'
import { RecoveryCaseAutonomy } from './recovery-case/RecoveryCaseAutonomy'
import { RecoveryCaseDecision } from './recovery-case/RecoveryCaseDecision'
import { useRecoveryCaseController, type RecoveryCasePanelProps } from './recovery-case/useRecoveryCaseController'

function recoveryCaseTone(
  state: RecoveryCase['state'],
  action: RecoveryCase['action'],
): 'danger' | 'warning' | 'info' | 'success' | 'neutral' {
  if (state === 'verified_recovered') return 'success'
  if (state === 'accepted_loss' || state === 'abandoned') return 'neutral'
  if (state === 'publishing' || state === 'monitoring') return 'info'
  if (state === 'recurred' || action === 'quarantine') return 'danger'
  return 'warning'
}

export function RecoveryCasePanel(props: RecoveryCasePanelProps) {
  const { t } = useT()
  const model = useRecoveryCaseController(props)
  const {
    caseId,
    onBack,
    onOpenRun,
    loading,
    loadError,
    loadCase,
    formatter,
    recoveryCase,
    transitions,
    details,
  } = model

  if (!caseId) {
    return (
      <PanelChrome
        title={t('recoveryCase.title')}
        description={t('recoveryCase.description')}
        icon={<ShieldAlert size={18} />}
      >
        <EmptyView
          icon={<CircleAlert size={20} />}
          title={t('recoveryCase.emptyTitle')}
          body={t('recoveryCase.emptyBody')}
          cta={{ label: t('recoveryCase.back'), onClick: onBack }}
        />
      </PanelChrome>
    )
  }

  return (
    <PanelChrome
      title={t('recoveryCase.title')}
      description={t('recoveryCase.description')}
      kicker={t('recoveryCase.kicker')}
      icon={<ShieldAlert size={18} />}
    >
      <Button
        className="we-recovery-case__back"
        onClick={onBack}
        size="sm"
        variant="ghost"
        leadingIcon={<ArrowLeft size={15} />}
      >
        {t('recoveryCase.back')}
      </Button>

      {loading && (
        <div className="we-card we-recovery-case__notice" role="status">
          <Clock3 size={17} aria-hidden="true" />
          <span>{t('recoveryCase.loading')}</span>
        </div>
      )}
      {loadError && (
        <div className="we-card we-recovery-case__notice" data-tone="danger" role="alert">
          <CircleAlert size={17} aria-hidden="true" />
          <span>{loadError}</span>
          <Button size="sm" variant="ghost" onClick={() => void loadCase()}>
            {t('common.retry')}
          </Button>
        </div>
      )}

      {recoveryCase && (
        <div
          className="we-recovery-case"
          data-testid={`recovery-case-workspace-${recoveryCase.id}`}
        >
          <section className="we-card we-recovery-case__summary">
            <div className="we-recovery-case__summary-head">
              <div>
                <div className="section-kicker">{t('recoveryCase.summaryKicker')}</div>
                <h3>{recoveryCase.message}</h3>
              </div>
              <span
                className="we-pill"
                data-tone={recoveryCaseTone(recoveryCase.state, recoveryCase.action)}
              >
                {t(`recoveryCase.state.${recoveryCase.state}`)}
              </span>
            </div>
            <div className="we-recovery-case__meta">
              <div>
                <span>{t('recoveryCase.detector')}</span>
                <strong>{recoveryCase.detectorId}</strong>
              </div>
              <div>
                <span>{t('recoveryCase.sourceNode')}</span>
                <strong>{recoveryCase.sourceNodeId}</strong>
              </div>
              <div>
                <span>{t('recoveryCase.policy')}</span>
                <strong>{t(`recoveryCenter.tile.semantic.action.${recoveryCase.action}`)}</strong>
              </div>
              <div>
                <span>{t('recoveryCase.created')}</span>
                <strong>{formatter.format(new Date(recoveryCase.createdAt))}</strong>
              </div>
            </div>
            {details.length > 0 && (
              <div className="we-recovery-case__evidence">
                <span>{t('recoveryCase.evidence')}</span>
                <ul>
                  {details.map((item, index) => (
                    <li key={`${index}:${item}`}>{item}</li>
                  ))}
                </ul>
              </div>
            )}
            <Button
              size="sm"
              variant="ghost"
              leadingIcon={<ExternalLink size={14} />}
              onClick={() => void onOpenRun(recoveryCase.runId)}
            >
              {t('recoveryCenter.tile.semantic.openRun')}
            </Button>
          </section>

          <RecoveryCaseAutonomy model={model} />

          <div className="we-recovery-case__columns">
            <section className="we-card we-recovery-case__history" aria-labelledby="recovery-case-history-title">
              <div className="we-recovery-case__section-head">
                <History size={17} aria-hidden="true" />
                <div>
                  <div className="section-kicker">{t('recoveryCase.historyKicker')}</div>
                  <h3 id="recovery-case-history-title">{t('recoveryCase.historyTitle')}</h3>
                </div>
              </div>
              {transitions.length === 0 ? (
                <p className="helper-text">{t('recoveryCase.historyEmpty')}</p>
              ) : (
                <ol className="we-recovery-case__timeline">
                  {transitions.map(transition => (
                    <li key={transition.id}>
                      <span className="we-recovery-case__timeline-dot" aria-hidden="true" />
                      <div>
                        <strong>
                          {t(`recoveryCase.state.${transition.fromState}`)}
                          <ArrowRight size={13} aria-hidden="true" />
                          {t(`recoveryCase.state.${transition.toState}`)}
                        </strong>
                        <span>
                          {t(`recoveryCase.actor.${transition.actorKind}`)}
                          {transition.actorId ? ` · ${transition.actorId}` : ''}
                          {' · '}
                          {formatter.format(new Date(transition.occurredAt))}
                        </span>
                        {transition.reason && <p>{transition.reason}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <RecoveryCaseDecision model={model} />
          </div>
        </div>
      )}
    </PanelChrome>
  )
}
