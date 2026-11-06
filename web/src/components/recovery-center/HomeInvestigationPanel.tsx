import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowRight, CircleCheck, CircleHelp, CircleX, LoaderCircle, X } from 'lucide-react'
import { contractApi } from '../../api'
import { tApiError, useT } from '../../i18n'
import { isGetRunsRunIdInvestigationResponse } from '../../lib/api-guards/operations/GetRunsRunIdInvestigation'
import type { ApiResponse } from '../../lib/api-types.generated'
import { Button } from '../ui/Button'
import './home-operator-panel.css'
import './home-investigation-panel.css'

type Investigation = ApiResponse<'GET /runs/{runId}/investigation'>
type Hypothesis = Investigation['hypotheses'][number]

export type HomeInvestigationPanelProps = {
  runId: string
  title: string
  onClose: () => void
  onOpenRun: (runId: string) => void | Promise<void>
  onOpenRecoveryQueue: (deadLetterId?: string) => void
}

const VERDICT_ICON = { validated: CircleCheck, ruled_out: CircleX, inconclusive: CircleHelp } as const
const VIEWS = ['steps', 'tree'] as const

export function HomeInvestigationPanel({ runId, title, onClose, onOpenRun, onOpenRecoveryQueue }: HomeInvestigationPanelProps) {
  const { t, i18n } = useT()
  const titleId = useId()
  const panelId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const [view, setView] = useState<(typeof VIEWS)[number]>('steps')
  const [settled, setSettled] = useState<{ runId: string; data?: Investigation; failed?: string } | null>(null)

  useEffect(() => { panelRef.current?.focus() }, [])

  useEffect(() => {
    const controller = new AbortController()
    void contractApi('GET /runs/{runId}/investigation', `/v1/runs/${encodeURIComponent(runId)}/investigation`, undefined, {
      signal: controller.signal, guard: isGetRunsRunIdInvestigationResponse,
    }).then((data) => {
      if (!controller.signal.aborted) setSettled({ runId, data })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setSettled({ runId, failed: tApiError(error) })
    })
    return () => { controller.abort() }
  }, [runId])

  const current = settled?.runId === runId ? settled : null
  const data = current?.data
  const question = data && (data.workflowName
    ? t('home.investigation.question', { step: data.nodeId, workflow: data.workflowName })
    : t('home.investigation.questionNoWorkflow', { step: data.nodeId }))

  const reason = (item: Hypothesis) => {
    const { category, expiredAt } = item.params
    return t(`home.investigation.reason.${item.reason}`, {
      ...item.params,
      ...(category && { category: t(`clusters.category.${category}`) }),
      ...(expiredAt && { expiredAt: new Date(expiredAt).toLocaleDateString(i18n.language) }),
    })
  }

  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const next = (index + (event.key === 'ArrowRight' ? 1 : VIEWS.length - 1)) % VIEWS.length
    setView(VIEWS[next])
    tabRefs.current[next]?.focus()
  }

  const verdict = (item: Hypothesis) => {
    const Icon = VERDICT_ICON[item.verdict]
    return (
      <span className="we-investigation__verdict" data-verdict={item.verdict}>
        <Icon size={13} aria-hidden="true" />
        {t(`home.investigation.verdict.${item.verdict}`)}
      </span>
    )
  }

  return (
    <section
      ref={panelRef}
      className="we-home-operator-panel"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}
      data-testid="home-investigation-panel"
    >
      <header className="we-home-operator-panel__head">
        <div>
          <small className="we-investigation__kicker">{t('home.investigation.kicker')}</small>
          <h2 id={titleId}>{title}</h2>
        </div>
        <Button variant="ghost" size="icon" aria-label={t('common.close')} onClick={onClose} data-testid="home-investigation-close">
          <X size={16} aria-hidden="true" />
        </Button>
      </header>

      <div className="we-investigation__tabs" role="tablist" aria-labelledby={titleId}>
        {VIEWS.map((option, index) => (
          <button
            key={option}
            id={`${panelId}-${option}`}
            ref={(node) => { tabRefs.current[index] = node }}
            type="button"
            role="tab"
            aria-selected={view === option}
            aria-controls={panelId}
            tabIndex={view === option ? 0 : -1}
            onClick={() => setView(option)}
            onKeyDown={(event) => moveTab(event, index)}
            data-testid={`home-investigation-tab-${option}`}
          >
            {t(`home.investigation.${option}`)}
            {option === 'steps' && data && <span className="we-investigation__count">{data.hypotheses.length}</span>}
          </button>
        ))}
      </div>

      <div id={panelId} className="we-home-operator-panel__body" role="tabpanel" aria-labelledby={`${panelId}-${view}`} aria-busy={!current}>
        {!current && (
          <p className="we-home-operator-panel__busy" role="status" data-testid="home-investigation-busy">
            <LoaderCircle size={15} aria-hidden="true" />
            {t('home.investigation.loading')}
          </p>
        )}
        {current?.failed !== undefined && (
          <p className="we-home-operator-panel__error" role="alert" data-testid="home-investigation-error">
            {current.failed || t('home.investigation.error')}
          </p>
        )}
        {data && view === 'steps' && (
          <div className="we-investigation">
            <p className="we-investigation__question">{question}</p>
            <ol className="we-investigation__steps" data-testid="home-investigation-steps">
              {data.hypotheses.map((item) => (
                <li key={item.id} data-verdict={item.verdict} data-testid={`home-investigation-step-${item.id}`}>
                  <div className="we-investigation__row">
                    <strong>{t(`home.investigation.hypothesis.${item.id}`)}</strong>
                    {verdict(item)}
                  </div>
                  <p>{reason(item)}</p>
                  {item.evidence.length > 0 && (
                    <ul className="we-investigation__evidence" aria-label={t('home.investigation.evidence')}>
                      {item.evidence.map((evidence) => (
                        <li key={`${evidence.kind}-${evidence.runId}`}>
                          <Button
                            size="sm"
                            variant="ghost"
                            trailingIcon={<ArrowRight size={13} />}
                            onClick={() => void onOpenRun(evidence.runId)}
                            data-testid={`home-investigation-evidence-${item.id}-${evidence.runId}`}
                          >
                            {t(`home.investigation.evidenceKind.${evidence.kind}`, { run: evidence.runId.slice(0, 8), step: evidence.nodeId ?? '' })}
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ol>
          </div>
        )}
        {data && view === 'tree' && (
          <div className="we-investigation__tree" data-testid="home-investigation-tree">
            <p className="we-investigation__root">{question}</p>
            <ul aria-label={question}>
              {data.hypotheses.map((item) => (
                <li key={item.id} data-verdict={item.verdict} data-testid={`home-investigation-node-${item.id}`}>
                  <div className="we-investigation__row">
                    <strong>{t(`home.investigation.hypothesis.${item.id}`)}</strong>
                    {verdict(item)}
                  </div>
                  <p>{reason(item)}</p>
                </li>
              ))}
            </ul>
          </div>
        )}
        {data && (
          <section className="we-investigation__conclusion" data-testid="home-investigation-conclusion">
            <h3>{t('home.investigation.conclusion')}</h3>
            <p>{data.conclusion ? t(`home.investigation.conclusionText.${data.conclusion}`) : t('home.investigation.noConclusion')}</p>
          </section>
        )}
      </div>

      {data?.action && (
        <footer className="we-home-operator-panel__foot">
          <Button
            variant="primary"
            size="sm"
            trailingIcon={<ArrowRight size={14} />}
            onClick={() => onOpenRecoveryQueue(data.action?.deadLetterId)}
            data-testid="home-investigation-action"
          >
            {t('home.investigation.action')}
          </Button>
        </footer>
      )}
    </section>
  )
}
