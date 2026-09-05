import { Gauge, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useT } from '../../i18n'
import type { RecoveryCaseModel } from './useRecoveryCaseController'

// The autonomy ladder the case's recovery contract grants.
export function RecoveryCaseAutonomy({ model }: { model: RecoveryCaseModel }) {
  const { t } = useT()
  const { autonomy, recoveryCase } = model
  if (!autonomy || !recoveryCase) return null
  return (
            <section
              className="we-card we-recovery-case__autonomy"
              data-level={autonomy.level ?? 'unavailable'}
              data-testid={`recovery-autonomy-profile-${recoveryCase.id}`}
              aria-labelledby="recovery-case-autonomy-title"
            >
              <div className="we-recovery-case__autonomy-head">
                <div className="we-recovery-case__section-head">
                  <Gauge size={17} aria-hidden="true" />
                  <div>
                    <div className="section-kicker">
                      {t('recoveryCase.autonomy.kicker')}
                    </div>
                    <h3 id="recovery-case-autonomy-title">
                      {t('recoveryCase.autonomy.title')}
                    </h3>
                  </div>
                </div>
                <span
                  className="we-pill"
                  data-tone={
                    autonomy.level === null
                      ? 'danger'
                      : autonomy.level >= 3
                        ? 'success'
                        : 'warning'
                  }
                >
                  {autonomy.level === null
                    ? t('recoveryCase.autonomy.unavailable')
                    : t('recoveryCase.autonomy.level', {
                        level: autonomy.level,
                      })}
                </span>
              </div>
              <p className="helper-text">
                {autonomy.level === null
                  ? t(
                      `recoveryCase.autonomy.reason.${autonomy.unavailableReason ?? 'failure_policy_missing'}`,
                    )
                  : t(`recoveryCase.autonomy.description.${autonomy.level}`)}
              </p>
              <div className="we-recovery-case__autonomy-meta">
                <span>
                  {t('recoveryCase.autonomy.source')}
                  <strong>
                    {t(`recoveryCase.autonomy.source.${autonomy.source}`)}
                  </strong>
                </span>
                <span>
                  {t('recoveryCase.autonomy.detectors')}
                  <strong>{autonomy.detectorIds.length}</strong>
                </span>
              </div>
              <ol className="we-recovery-case__autonomy-ladder">
                {autonomy.factors.map(factor => (
                  <li
                    key={factor.capability}
                    data-enabled={factor.enabled}
                  >
                    <span className="we-recovery-case__autonomy-level">
                      {factor.requiredLevel}
                    </span>
                    <span>
                      <strong>
                        {t(
                          `recoveryCase.autonomy.capability.${factor.capability}`,
                        )}
                      </strong>
                      <small>
                        {t(
                          factor.enabled
                            ? 'recoveryCase.autonomy.enabled'
                            : 'recoveryCase.autonomy.disabled',
                        )}
                      </small>
                    </span>
                    {factor.enabled
                      ? <ShieldCheck size={15} aria-hidden="true" />
                      : <LockKeyhole size={15} aria-hidden="true" />}
                  </li>
                ))}
              </ol>
            </section>
  )
}
