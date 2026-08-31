import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleDot,
  Clock3,
  LoaderCircle,
} from 'lucide-react'
import { useT } from '../../i18n'
import type { RunSummary } from '../../types'
import { Button } from '../ui/Button'
import { StatusSummary } from '../ui/StatusSummary'
import type {
  RecommendedAction,
} from './recovery-center-model'

function runTone(run: RunSummary): 'warning' | 'primary' {
  return run.status === 'waiting' || run.hasWaitingNodes ? 'warning' : 'primary'
}

export function HomeActionWorkspace({
  actions,
  activeRuns,
  activeRunCount,
  status,
  warnings,
  onSelectAction,
  onOpenRun,
  onOpenActivity,
}: {
  actions: RecommendedAction[]
  activeRuns: RunSummary[]
  activeRunCount: number
  status: 'loading' | 'available' | 'unavailable'
  warnings: string[]
  onSelectAction: (action: RecommendedAction) => void
  onOpenRun: (runId: string) => void | Promise<void>
  onOpenActivity: () => void
}) {
  const { t } = useT()
  return (
    <div className="we-home-workspace">
      <section
        className="we-home-priority we-card"
        aria-labelledby="we-home-priority-title"
        data-testid="home-priority-inbox"
      >
        <header className="we-home-section-head">
          <h2 id="we-home-priority-title">{t('home.priority.title')}</h2>
          {actions.length > 0 && (
            <span className="we-pill" data-tone="warning">
              <span className="we-sr-only">{t('home.priority.title')}: </span>
              {actions.length}
            </span>
          )}
        </header>

        {status === 'loading' ? (
          <div className="we-home-priority__state" role="status">
            <LoaderCircle className="we-home-priority__spinner" size={20} aria-hidden="true" />
            <div>
              <strong>{t('home.priority.loadingTitle')}</strong>
              <p>{t('home.priority.loadingBody')}</p>
            </div>
          </div>
        ) : status === 'unavailable' ? (
          <StatusSummary
            className="we-home-priority__status"
            role="status"
            tone="warning"
            icon={<AlertTriangle size={20} />}
            title={t('home.priority.unavailableTitle')}
            description={t('home.priority.unavailableBody')}
          />
        ) : actions.length === 0 ? (
          <div className="we-home-priority__clear" data-testid="home-priority-clear">
            <span aria-hidden="true"><CheckCircle2 size={20} /></span>
            <div>
              <strong>{t('home.priority.clearTitle')}</strong>
              <p>{t('home.priority.clearBody')}</p>
            </div>
            <Button type="button" variant="secondary" size="sm" onClick={onOpenActivity} trailingIcon={<ArrowRight size={14} />}>
              {t('workspace.destination.activity.label')}
            </Button>
          </div>
        ) : (
          <ol className="we-home-priority__list">
            {actions.map((action, index) => (
              <li
                key={action.id}
                data-severity={action.severity}
                data-testid={`recovery-center-action-${action.id}`}
              >
                <span className="we-home-priority__order" aria-hidden="true">
                  {index + 1}
                </span>
                <div className="we-home-priority__copy">
                  <strong>{action.title}</strong>
                  <p>{action.body}</p>
                </div>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => onSelectAction(action)}
                  data-testid={`recovery-center-action-cta-${action.id}`}
                  trailingIcon={<ArrowRight size={14} />}
                >
                  {action.ctaLabel}
                </Button>
              </li>
            ))}
          </ol>
        )}
        {status === 'available' && warnings.length > 0 ? (
          <p className="we-home-priority__warning" role="status">
            {t('home.priority.degraded')}
          </p>
        ) : null}
      </section>

      <section
        className="we-home-active we-card"
        aria-labelledby="we-home-active-title"
        data-testid="home-active-work"
      >
        <header className="we-home-section-head">
          <h2 id="we-home-active-title">{t('home.active.title')}</h2>
          <span className="we-pill" data-tone={activeRunCount > 0 ? 'primary' : 'neutral'}>
            <span className="we-sr-only">{t('home.active.title')}: </span>
            {activeRunCount}
          </span>
        </header>

        {activeRuns.length === 0 ? (
          <div className="we-home-active__empty" data-testid="home-active-empty">
            <span aria-hidden="true"><CircleDot size={18} /></span>
            <div>
              <strong>{t('home.active.emptyTitle')}</strong>
            </div>
          </div>
        ) : (
          <ul className="we-home-active__list" aria-label={t('home.active.title')}>
            {activeRuns.map((run) => {
              const workflowName = run.workflowName ?? run.workflowId ?? t('home.active.unknownWorkflow')
              return (
                <li key={run.id}>
                  <button
                    type="button"
                    onClick={() => void onOpenRun(run.id)}
                    data-testid={`home-active-run-${run.id}`}
                  >
                    <span className="we-home-active__status" data-tone={runTone(run)} aria-hidden="true">
                      {run.hasWaitingNodes || run.status === 'waiting'
                        ? <Clock3 size={15} />
                        : <CircleDot size={15} />}
                    </span>
                    <span className="we-home-active__copy">
                      <strong>{workflowName}</strong>
                      <small>{t(`status.${run.hasWaitingNodes ? 'waiting' : run.status}`)}</small>
                    </span>
                    <ArrowRight size={15} aria-hidden="true" />
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        <button type="button" className="we-home-active__footer" onClick={onOpenActivity}>
          {t('workspace.destination.activity.label')}
          <ArrowRight size={14} aria-hidden="true" />
        </button>
      </section>
    </div>
  )
}
