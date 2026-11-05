import { useEffect, useId, useRef, useState } from 'react'
import {
  ArrowRight,
  BarChart3,
  DollarSign,
  FileDiff,
  LoaderCircle,
  ShieldAlert,
  Wand2,
  X,
} from 'lucide-react'
import { api } from '../../api'
import { useT } from '../../i18n'
import { isNonEmptyString, isRecord } from '../../lib/guards'
import { useWorkflowStore } from '../../store'
import type { ActiveTab } from '../../types'
import type { DeadLetter } from '../dead-letter-types'
import { Button } from '../ui/Button'
import './home-operator-panel.css'

/** `runId` asks about that run; without it the question is about the loaded draft. */
export type OperatorRequest = { question: string; prompt?: string; runId?: string }

export type HomeOperatorPanelProps = {
  request: OperatorRequest | null
  /** Newest first: the first one is what "why did it fail" asks about. */
  openFailures: Array<Pick<DeadLetter, 'id' | 'runId'>>
  onAsk: (request: OperatorRequest) => void
  onClose: () => void
  onOpenTab: (tab: ActiveTab) => void
  onOpenRun: (runId: string) => void | Promise<void>
  onOpenRecoveryQueue: (deadLetterId?: string) => void
}

type RunEvidence = {
  runId: string
  status?: string
  nodeId?: string
  signature?: string
  errorSummary?: string
  nextAction?: string
}

type Answer = { text?: string; mode: 'ai' | 'fallback'; aiError?: string; evidence: RunEvidence | null }
type Outcome = { answer: Answer } | { error?: string }

function text(value: unknown): string | undefined {
  return isNonEmptyString(value) ? value : undefined
}

function readEvidence(report: unknown): RunEvidence | null {
  if (!isRecord(report) || !isRecord(report.summary)) return null
  const runId = text(report.summary.runId)
  if (!runId) return null
  const rootCause = isRecord(report.rootCause) ? report.rootCause : {}
  const failedNode = isRecord(report.failedNode) ? report.failedNode : {}
  return {
    runId,
    status: text(report.summary.status),
    nodeId: text(failedNode.nodeId),
    signature: text(rootCause.signature),
    errorSummary: text(failedNode.errorSummary),
    nextAction: text(report.nextAction),
  }
}

function explainBody(request: OperatorRequest) {
  if (request.runId) return { runId: request.runId, question: request.question }
  const { nodes, edges, currentWorkflowId, currentWorkflowName } = useWorkflowStore.getState()
  return {
    prompt: request.prompt ?? request.question,
    workflow: {
      id: currentWorkflowId,
      name: currentWorkflowName,
      nodes: nodes.map((node) => ({ id: node.id, type: node.data.type, config: node.data.config ?? {}, position: node.position })),
      edges: edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target, data: edge.data })),
    },
  }
}

// Without a draft or a failed run there is nothing to explain, so each one opens the surface that has the answer.
const SUGGESTIONS = [
  { id: 'suggestFix', icon: Wand2, label: 'recoveryCenter.composer.chip.suggestFix', prompt: 'recoveryCenter.composer.intent.suggestFixPrompt', withoutDraft: 'operations' },
  { id: 'whyFail', icon: ShieldAlert, label: 'recoveryCenter.composer.chip.whyFail' },
  { id: 'whatChanged', icon: FileDiff, label: 'recoveryCenter.composer.chip.whatChanged', prompt: 'recoveryCenter.composer.intent.whatChangedPrompt', withoutDraft: 'inspector' },
  { id: 'summarize', icon: BarChart3, label: 'recoveryCenter.composer.chip.summarize', prompt: 'recoveryCenter.composer.intent.summarizePrompt', withoutDraft: 'operations' },
  { id: 'spend', icon: DollarSign, label: 'recoveryCenter.composer.chip.spend', prompt: 'recoveryCenter.composer.intent.spendPrompt', withoutDraft: 'operations' },
] as const

export function HomeOperatorPanel({
  request,
  openFailures,
  onAsk,
  onClose,
  onOpenTab,
  onOpenRun,
  onOpenRecoveryQueue,
}: HomeOperatorPanelProps) {
  const { t } = useT()
  const titleId = useId()
  const panelRef = useRef<HTMLElement>(null)
  const hasDraft = useWorkflowStore((state) => state.nodes.length > 0)
  const draftName = useWorkflowStore((state) => state.currentWorkflowName)
  const [settled, setSettled] = useState<{ request: OperatorRequest; outcome: Outcome } | null>(null)

  useEffect(() => { panelRef.current?.focus() }, [])

  useEffect(() => {
    if (!request || (!request.runId && useWorkflowStore.getState().nodes.length === 0)) return
    const controller = new AbortController()
    const settle = (outcome: Outcome) => {
      if (!controller.signal.aborted) setSettled({ request, outcome })
    }
    void api(request.runId ? '/ai/explain-run' : '/ai/explain-workflow', {
      method: 'POST',
      body: JSON.stringify(explainBody(request)),
      signal: controller.signal,
    }).then((result) => {
      const body = isRecord(result) ? result : {}
      if (text(body.error)) {
        settle({ error: text(body.error) })
        return
      }
      settle({
        answer: {
          text: text(body.explanation),
          mode: body.mode === 'ai' ? 'ai' : 'fallback',
          aiError: text(body.aiError),
          evidence: readEvidence(body.report),
        },
      })
    }).catch((error: unknown) => {
      settle({ error: error instanceof Error ? error.message : undefined })
    })
    return () => { controller.abort() }
  }, [request])

  const needsDraft = Boolean(request && !request.runId && !hasDraft)
  const outcome = settled?.request === request ? settled?.outcome : undefined
  const busy = Boolean(request) && !needsDraft && !outcome
  const answer = outcome && 'answer' in outcome ? outcome.answer : null
  const failed = outcome && 'error' in outcome ? outcome : null
  const evidence = answer?.evidence ?? null
  // The server reports a missing key with this fixed text, or with no error at all on run answers.
  const noProvider = !answer?.aiError || answer.aiError === 'AI provider not configured'
  const summarized = answer?.mode === 'fallback' && evidence !== null
  const facts = evidence ? [
    { label: t('home.operator.rootCause'), value: evidence.signature },
    { label: t('home.operator.failedStep'), value: evidence.nodeId },
    { label: t('home.operator.error'), value: evidence.errorSummary },
    { label: t('home.operator.nextAction'), value: evidence.nextAction },
  ].filter((fact) => fact.value) : []
  const recoverable = openFailures.find((failure) => failure.runId === evidence?.runId)

  const choose = (suggestion: (typeof SUGGESTIONS)[number]) => {
    const question = t(suggestion.label)
    if ('prompt' in suggestion) {
      if (hasDraft) onAsk({ question, prompt: t(suggestion.prompt) })
      else onOpenTab(suggestion.withoutDraft)
    } else if (openFailures[0]) {
      onAsk({ question, runId: openFailures[0].runId })
    } else {
      onOpenTab('runs')
    }
  }

  return (
    <section
      ref={panelRef}
      className="we-home-operator-panel"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={(event) => { if (event.key === 'Escape') onClose() }}
      data-testid="home-operator-panel"
    >
      <header className="we-home-operator-panel__head">
        <h2 id={titleId}>{t('recoveryCenter.composer.kicker')}</h2>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t('common.close')}
          onClick={onClose}
          data-testid="home-operator-close"
        >
          <X size={16} aria-hidden="true" />
        </Button>
      </header>

      <div className="we-home-operator-panel__body">
        <div aria-live="polite" className="we-home-operator-panel__answer">
          {request && <p className="we-home-operator-panel__question">{request.question}</p>}
          {busy && (
            <p className="we-home-operator-panel__busy" role="status" data-testid="home-operator-busy">
              <LoaderCircle size={15} aria-hidden="true" />
              {t('recoveryCenter.composer.thinking')}
            </p>
          )}
          {needsDraft && <p data-testid="home-operator-needs-draft">{t('recoveryCenter.composer.needWorkflow')}</p>}
          {failed && (
            <p className="we-home-operator-panel__error" role="alert" data-testid="home-operator-error">
              {failed.error ?? t('recoveryCenter.composer.callFailed')}
            </p>
          )}
          {answer && (
            <div data-testid="home-operator-answer">
              <div className="we-home-operator-panel__mode" data-mode={answer.mode} data-testid="home-operator-mode">
                <strong>{answer.mode === 'ai' ? t('recoveryCenter.composer.modeAi') : t('recoveryCenter.composer.modeFallback')}</strong>
                {answer.mode === 'fallback' && (
                  <span>{noProvider ? t('home.operator.noProvider') : t('home.operator.providerFailed')}</span>
                )}
                {answer.mode === 'fallback' && !noProvider && <code>{answer.aiError}</code>}
              </div>
              {!request?.runId && <small>{t('home.operator.aboutDraft', { name: draftName })}</small>}
              {summarized ? (
                <>
                  <dl className="we-home-operator-panel__facts">
                    {facts.map((fact) => (
                      <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
                    ))}
                  </dl>
                  {answer.text && (
                    <details data-testid="home-operator-full-report">
                      <summary>{t('home.operator.fullReport')}</summary>
                      <pre>{answer.text}</pre>
                    </details>
                  )}
                </>
              ) : (
                <p className="we-home-operator-panel__text">{answer.text ?? t('recoveryCenter.composer.noAnswer')}</p>
              )}
            </div>
          )}
        </div>

        {evidence && (
          <section>
            <h3>{t('home.operator.citedRun')}</h3>
            <Button
              size="sm"
              trailingIcon={<ArrowRight size={14} />}
              onClick={() => void onOpenRun(evidence.runId)}
              data-testid="home-operator-citation"
            >
              <code>{evidence.runId.slice(0, 8)}</code>
              {evidence.status && ` · ${t(`status.${evidence.status}`)}`}
            </Button>
          </section>
        )}

        <section>
          <h3>{t('home.operator.suggestions')}</h3>
          <div className="we-home-operator-panel__suggestions">
            {SUGGESTIONS.map((suggestion) => (
              <Button
                key={suggestion.id}
                size="sm"
                variant="ghost"
                leadingIcon={<suggestion.icon size={13} />}
                disabled={busy}
                onClick={() => choose(suggestion)}
                data-testid={`home-operator-suggestion-${suggestion.id}`}
              >
                {t(suggestion.label)}
              </Button>
            ))}
          </div>
        </section>
      </div>

      {request && (
        <footer className="we-home-operator-panel__foot">
          {recoverable && (
            <Button
              variant="primary"
              size="sm"
              trailingIcon={<ArrowRight size={14} />}
              onClick={() => onOpenRecoveryQueue(recoverable.id)}
              data-testid="home-operator-action"
            >
              {t('home.operator.openRecovery')}
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={() => onOpenTab('ai-studio')} data-testid="home-operator-open-studio">
            {t('recoveryCenter.composer.openStudio')}
          </Button>
        </footer>
      )}
    </section>
  )
}
