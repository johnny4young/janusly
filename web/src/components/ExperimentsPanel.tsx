/**
 * Operator UI for the prompt/model experiment harness.
 *
 * Used by:
 * - `RightPanel.tsx` — lazy-loaded on the Experiments workspace tab.
 *
 * Invariants:
 * - The API is the source of truth for summaries; this panel validates only
 *   enough to avoid empty requests and renders unknown summary data safely.
 * - Promotion is recommendation-only. A successful candidate can be copied
 *   for manual review, but this UI never mutates prompts or org config.
 * - Creating a dataset or running an experiment bumps platform version so
 *   other server-data panels refresh through the shared store contract.
 */

import React, { useEffect, useState } from 'react'
import { ArrowRight, ChartNoAxesCombined, CheckCircle2, CircleAlert, FlaskConical, Play, Plus, RefreshCw } from 'lucide-react'

import { api } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { ExperimentSummaryDetail } from './experiments/ExperimentSummary'
import { asRecord, DEFAULT_MAX_PROVIDER_CALLS, estimateProviderCalls, formatDate, getRunBlockers, INITIAL_RUN_FORM, SETUP_STEPS, updateExperiment, type EvalDataset, type Experiment, type ExperimentKind, type RunForm, type SetupStep } from './experiments/types'
import { EmptyView } from './panel-primitives'
import { Button } from '@/components/ui/Button'
import { FieldLabel, SelectControl, TextInput } from '@/components/ui/Form'
import './experiments/experiments.css'
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'

const EXPERIMENT_MUTATION_TAGS = ['experiments'] as const

const EXPERIMENT_TAGS = [PLATFORM_TAG, 'experiments'] as const

const STEP_FIRST_FIELD: Record<SetupStep, string> = {
  dataset: 'experiment-dataset',
  arms: 'experiment-kind',
  run: 'experiment-scorer',
}

export function ExperimentsPanel({ canWrite = true }: { canWrite?: boolean } = {}): React.ReactElement {
  const { t } = useT()
  const platformVersion = useInvalidationNonce(EXPERIMENT_TAGS)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [datasets, setDatasets] = useState<EvalDataset[]>([])
  const [datasetsFailed, setDatasetsFailed] = useState(false)
  const [step, setStep] = useState<SetupStep>('dataset')
  const [pendingFocus, setPendingFocus] = useState<{ field: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [maxProviderCalls, setMaxProviderCalls] = useState(DEFAULT_MAX_PROVIDER_CALLS)
  const [selected, setSelected] = useState<Experiment | null>(null)
  const [runForm, setRunForm] = useState<RunForm>(INITIAL_RUN_FORM)
  const [datasetName, setDatasetName] = useState('')
  const [datasetDescription, setDatasetDescription] = useState('')
  const [datasetRetentionDays, setDatasetRetentionDays] = useState('')
  const [creatingDataset, setCreatingDataset] = useState(false)
  const [running, setRunning] = useState(false)

  // The target field only mounts once the step change commits.
  useEffect(() => {
    if (pendingFocus) document.getElementById(pendingFocus.field)?.focus()
  }, [pendingFocus])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.allSettled([
      api('/experiments'),
      api('/eval/datasets'),
    ]).then(([experimentsResult, datasetsResult]) => {
      if (cancelled) return
      const experimentsResponse = experimentsResult.status === 'fulfilled' ? experimentsResult.value : null
      const datasetsResponse = datasetsResult.status === 'fulfilled' ? datasetsResult.value : null
      const experimentList = asRecord(experimentsResponse)?.experiments
      const datasetList = asRecord(datasetsResponse)?.datasets
      setExperiments(Array.isArray(experimentList) ? experimentList as Experiment[] : [])
      const limits = asRecord(asRecord(experimentsResponse)?.limits)
      const serverMaxProviderCalls = limits?.maxProviderCalls
      setMaxProviderCalls(typeof serverMaxProviderCalls === 'number' && serverMaxProviderCalls > 0
        ? serverMaxProviderCalls
        : DEFAULT_MAX_PROVIDER_CALLS)
      const nextDatasets = Array.isArray(datasetList) ? datasetList as EvalDataset[] : []
      setDatasets(nextDatasets)
      setDatasetsFailed(datasetsResult.status === 'rejected')
      setRunForm((current) => current.evalDatasetId || nextDatasets.length === 0
        ? current
        : { ...current, evalDatasetId: nextDatasets[0]!.id })
      setLoadError([experimentsResult, datasetsResult]
        .map((result) => result.status === 'rejected' ? tApiError(result.reason) : '')
        .filter(Boolean)
        .join(' · ') || null)
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [platformVersion])

  async function createDataset(): Promise<void> {
    const name = datasetName.trim()
    if (!name) return
    setCreatingDataset(true)
    try {
      const response = asRecord(await api('/eval/datasets', {
        method: 'POST',
        body: JSON.stringify({
          name,
          ...(datasetDescription.trim() ? { description: datasetDescription.trim() } : {}),
          ...(datasetRetentionDays ? { retentionDays: Number(datasetRetentionDays) } : {}),
        }),
      }))
      const dataset = response?.dataset as EvalDataset | undefined
      if (!dataset) throw new Error(t('experiments.toast.datasetError'))
      setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)])
      setRunForm((current) => ({ ...current, evalDatasetId: dataset.id }))
      setDatasetName('')
      setDatasetDescription('')
      setDatasetRetentionDays('')
      addToast(t('experiments.toast.datasetCreated'), 'success')
      bumpPlatformVersion(EXPERIMENT_MUTATION_TAGS)
    } catch (error) {
      addToast(tApiError(error) || t('experiments.toast.datasetError'), 'error')
    } finally {
      setCreatingDataset(false)
    }
  }

  async function runExperiment(): Promise<void> {
    if (!canRun) return
    setRunning(true)
    try {
      const response = asRecord(await api('/experiments/run', {
        method: 'POST',
        body: JSON.stringify({
          name: runForm.name.trim(),
          kind: runForm.kind,
          controlRef: runForm.controlRef.trim(),
          candidateRef: runForm.candidateRef.trim(),
          evalDatasetId: runForm.evalDatasetId,
          scorerKind: runForm.scorerKind,
        }),
      }))
      const experiment = response?.experiment as Experiment | undefined
      const summary = response?.summary
      if (!experiment) throw new Error(t('experiments.toast.runError'))
      const completed = { ...experiment, summary: summary ?? experiment.summary }
      setExperiments((current) => updateExperiment(current, completed))
      setSelected(completed)
      addToast(t('experiments.toast.runCompleted'), 'success')
      bumpPlatformVersion(EXPERIMENT_MUTATION_TAGS)
    } catch (error) {
      addToast(tApiError(error) || t('experiments.toast.runError'), 'error')
    } finally {
      setRunning(false)
    }
  }

  async function copyCandidateReference(): Promise<void> {
    if (!selected) return
    try {
      await navigator.clipboard.writeText(selected.candidateRef)
      addToast(t('experiments.toast.candidateCopied'), 'success')
    } catch {
      addToast(t('experiments.toast.copyError'), 'error')
    }
  }

  function goToField(target: SetupStep, field: string): void {
    setStep(target)
    setPendingFocus({ field })
  }

  const selectedDataset = datasets.find((dataset) => dataset.id === runForm.evalDatasetId) ?? null
  const providerCallEstimate = estimateProviderCalls(selectedDataset?.exampleCount ?? 0, runForm.scorerKind)
  const callPlanAllowed = providerCallEstimate > 0 && providerCallEstimate <= maxProviderCalls
  const blockers = getRunBlockers(runForm, datasets, loading ? 'loading' : datasetsFailed ? 'failed' : 'ready', maxProviderCalls)
  const blocker = blockers[0]
  const canRun = canWrite && !blocker
  const nextStep = SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1]
  const runDescription = [
    selectedDataset && 'experiment-call-plan',
    !canRun && 'experiment-run-blocker',
  ].filter(Boolean).join(' ')

  return (
    <div className="we-experiments" data-testid="experiments-panel">
      <section className="we-card we-experiments__setup" aria-labelledby="experiments-run-title">
        <div className="we-card__header">
          <div>
            <div className="section-kicker">{t('experiments.setup.kicker')}</div>
            <h3 id="experiments-run-title">{t('experiments.setup.title')}</h3>
          </div>
          <FlaskConical size={18} aria-hidden="true" />
        </div>
        <p className="helper-text">{t('experiments.setup.description')}</p>
        <ol className="we-experiments__steps" aria-labelledby="experiments-run-title">
          {SETUP_STEPS.map((id, index) => (
            <li key={id}>
              <button
                type="button"
                className="we-experiments__step"
                data-testid={`experiment-step-${id}`}
                aria-current={step === id ? 'step' : undefined}
                onClick={() => setStep(id)}
              >
                <small>{t('experiments.step.label', { number: index + 1 })}</small>
                <strong>{t(`experiments.step.${id}`)}</strong>
                {!blockers.some((item) => item.step === id) && (
                  <span className="we-experiments__step-done" data-testid={`experiment-step-done-${id}`}>
                    <CheckCircle2 size={14} aria-hidden="true" />
                    <span className="we-sr-only">{t('experiments.step.complete')}</span>
                  </span>
                )}
              </button>
            </li>
          ))}
        </ol>
        {step === 'dataset' && (
          <div className="we-experiments__form" data-testid="experiment-panel-dataset">
            {(datasets.length > 0 || !canWrite) && (
              <>
                <FieldLabel htmlFor="experiment-dataset">{t('experiments.field.dataset')}</FieldLabel>
                <SelectControl id="experiment-dataset" value={runForm.evalDatasetId} onChange={(event) => setRunForm((current) => ({ ...current, evalDatasetId: event.target.value }))}>
                  <option value="">{t('experiments.dataset.placeholder')}</option>
                  {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{t('experiments.dataset.option', { name: dataset.name, count: dataset.exampleCount })}</option>)}
                </SelectControl>
              </>
            )}
            {canWrite && (
              <div className="we-experiments__create" data-testid="experiment-create-dataset">
                <h4>{t('experiments.dataset.createTitle')}</h4>
                <p className="helper-text">{t('experiments.dataset.description')}</p>
                <div className="we-experiments__dataset-form">
                  <FieldLabel htmlFor="experiment-dataset-name">{t('experiments.dataset.name')}</FieldLabel>
                  <TextInput id="experiment-dataset-name" value={datasetName} onChange={(event) => setDatasetName(event.target.value)} />
                  <FieldLabel htmlFor="experiment-dataset-description">{t('experiments.dataset.descriptionLabel')}</FieldLabel>
                  <TextInput id="experiment-dataset-description" value={datasetDescription} onChange={(event) => setDatasetDescription(event.target.value)} />
                  <FieldLabel htmlFor="experiment-dataset-retention">{t('experiments.dataset.retentionLabel')}</FieldLabel>
                  <SelectControl
                    id="experiment-dataset-retention"
                    value={datasetRetentionDays}
                    onChange={(event) => setDatasetRetentionDays(event.target.value)}
                  >
                    <option value="">{t('experiments.dataset.retention.none')}</option>
                    {[30, 90, 365].map((days) => (
                      <option key={days} value={days}>{t('experiments.dataset.retention.days', { count: days })}</option>
                    ))}
                  </SelectControl>
                  <Button variant="secondary" type="button" data-testid="experiment-dataset-create" onClick={() => void createDataset()} disabled={!datasetName.trim() || creatingDataset}>
                    <Plus size={14} aria-hidden="true" />
                    {creatingDataset ? t('experiments.action.creatingDataset') : t('experiments.action.createDataset')}
                  </Button>
                </div>
                <p className="helper-text">{t('experiments.dataset.retentionHelp')}</p>
              </div>
            )}
          </div>
        )}
        {step === 'arms' && (
          <div className="we-experiments__form" data-testid="experiment-panel-arms">
            <FieldLabel htmlFor="experiment-kind">{t('experiments.field.kind')}</FieldLabel>
            <SelectControl id="experiment-kind" value={runForm.kind} onChange={(event) => setRunForm((current) => ({ ...current, kind: event.target.value as ExperimentKind }))}>
              <option value="prompt">{t('experiments.kind.prompt')}</option>
              <option value="model">{t('experiments.kind.model')}</option>
            </SelectControl>
            <p className="helper-text we-experiments__ref-hint">{t(`experiments.refHint.${runForm.kind}`)}</p>
            <FieldLabel htmlFor="experiment-control">{t('experiments.field.control')}</FieldLabel>
            <TextInput id="experiment-control" value={runForm.controlRef} onChange={(event) => setRunForm((current) => ({ ...current, controlRef: event.target.value }))} />
            <FieldLabel htmlFor="experiment-candidate">{t('experiments.field.candidate')}</FieldLabel>
            <TextInput id="experiment-candidate" value={runForm.candidateRef} onChange={(event) => setRunForm((current) => ({ ...current, candidateRef: event.target.value }))} />
          </div>
        )}
        {step === 'run' && (
          <div className="we-experiments__form" data-testid="experiment-panel-run">
            <FieldLabel htmlFor="experiment-scorer">{t('experiments.field.scorer')}</FieldLabel>
            <SelectControl id="experiment-scorer" value={runForm.scorerKind} onChange={(event) => setRunForm((current) => ({ ...current, scorerKind: event.target.value as RunForm['scorerKind'] }))}>
              <option value="string_equality">{t('experiments.scorer.stringEquality')}</option>
              <option value="json_schema">{t('experiments.scorer.jsonSchema')}</option>
              <option value="llm_judge">{t('experiments.scorer.llmJudge')}</option>
            </SelectControl>
            <FieldLabel htmlFor="experiment-name">{t('experiments.field.name')}</FieldLabel>
            <TextInput id="experiment-name" value={runForm.name} onChange={(event) => setRunForm((current) => ({ ...current, name: event.target.value }))} />
          </div>
        )}
        {selectedDataset && (
          <p
            id="experiment-call-plan"
            className={`helper-text${callPlanAllowed ? '' : ' helper-text--error'}`}
            role={callPlanAllowed ? 'status' : 'alert'}
          >
            {selectedDataset.exampleCount === 0
              ? t('experiments.plan.empty')
              : providerCallEstimate > maxProviderCalls
                ? t('experiments.plan.exceeds', { count: providerCallEstimate, max: maxProviderCalls })
                : t('experiments.plan.calls', { count: providerCallEstimate, max: maxProviderCalls })}
          </p>
        )}
        <div className="form-actions we-experiments__actions">
          {!canWrite ? (
            <p id="experiment-run-blocker" className="helper-text" data-testid="experiment-run-blocker">{t('experiments.blocker.readOnly')}</p>
          ) : blocker && (
            <Button
              id="experiment-run-blocker"
              variant="ghost"
              size="sm"
              type="button"
              className="we-experiments__blocker"
              data-testid="experiment-run-blocker"
              leadingIcon={<CircleAlert size={14} />}
              onClick={() => goToField(blocker.step, blocker.field)}
            >
              {t('experiments.blocker.line', {
                number: SETUP_STEPS.indexOf(blocker.step) + 1,
                step: t(`experiments.step.${blocker.step}`),
                reason: t(`experiments.blocker.${blocker.reason}`),
              })}
            </Button>
          )}
          {nextStep && (
            <Button variant="secondary" type="button" data-testid="experiment-step-next" trailingIcon={<ArrowRight size={14} />} onClick={() => goToField(nextStep, STEP_FIRST_FIELD[nextStep])}>
              {t('experiments.action.next')}
            </Button>
          )}
          <Button variant="primary" type="button" data-testid="experiment-run" onClick={() => void runExperiment()} disabled={!canRun || running} aria-describedby={runDescription || undefined}>
            <Play size={14} aria-hidden="true" />
            {running ? t('experiments.action.running') : t('experiments.action.run')}
          </Button>
        </div>
      </section>

      <section className="we-card" aria-labelledby="experiments-history-title">
        <div className="we-card__header">
          <div>
            <div className="section-kicker">{t('experiments.history.kicker')}</div>
            <h3 id="experiments-history-title">{t('experiments.history.title')}</h3>
          </div>
          <Button variant="ghost" type="button"  onClick={() => bumpPlatformVersion(EXPERIMENT_MUTATION_TAGS)} aria-label={t('experiments.action.refresh')}>
            <RefreshCw size={14} aria-hidden="true" />
          </Button>
        </div>
        {loadError && (
          <div className="run-input-form-error" role="alert">
            <span>{loadError}</span>
            <Button variant="ghost" type="button"  onClick={() => bumpPlatformVersion(EXPERIMENT_MUTATION_TAGS)}>{t('common.retry')}</Button>
          </div>
        )}
        {loading ? <p className="helper-text">{t('common.loading')}</p> : experiments.length === 0 ? (
          <EmptyView icon={<ChartNoAxesCombined size={22} />} title={t('experiments.history.empty.title')} body={t('experiments.history.empty.body')} />
        ) : (
          <ul className="we-experiments__list">
            {experiments.map((experiment) => (
              <li key={experiment.id}>
                <button type="button" className="we-experiments__row" data-selected={selected?.id === experiment.id ? 'true' : 'false'} onClick={() => setSelected(experiment)}>
                  <span>
                    <strong>{experiment.name}</strong>
                    <small>{formatDate(experiment.completedAt ?? experiment.createdAt) ?? t('common.unknown')}</small>
                  </span>
                  <span className="we-pill" data-tone="info">{t(`experiments.status.${experiment.status}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected && <ExperimentSummaryDetail experiment={selected} onCopyCandidate={() => void copyCandidateReference()} />}
    </div>
  )
}
