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

import React, { useEffect, useRef, useState } from 'react'
import { ChartNoAxesCombined, FlaskConical, Play, Plus, RefreshCw } from 'lucide-react'

import { api } from '../api'
import { tApiError, useT } from '../i18n'
import { useWorkflowStore } from '../store'
import { ExperimentSummaryDetail } from './experiments/ExperimentSummary'
import { asRecord, formatDate, INITIAL_RUN_FORM, updateExperiment, type EvalDataset, type Experiment, type ExperimentKind, type RunForm } from './experiments/types'
import { EmptyView } from './panel-primitives'

export function ExperimentsPanel(): React.ReactElement {
  const { t } = useT()
  const platformVersion = useWorkflowStore((state) => state.platformVersion)
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion)
  const addToast = useWorkflowStore((state) => state.addToast)
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [datasets, setDatasets] = useState<EvalDataset[]>([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<Experiment | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [runForm, setRunForm] = useState<RunForm>(INITIAL_RUN_FORM)
  const [datasetName, setDatasetName] = useState('')
  const [datasetDescription, setDatasetDescription] = useState('')
  const [creatingDataset, setCreatingDataset] = useState(false)
  const [running, setRunning] = useState(false)
  const detailRequestId = useRef(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([
      api('/experiments').catch(() => ({ experiments: [] })),
      api('/eval/datasets').catch(() => ({ datasets: [] })),
    ]).then(([experimentsResponse, datasetsResponse]) => {
      if (cancelled) return
      const experimentList = asRecord(experimentsResponse)?.experiments
      const datasetList = asRecord(datasetsResponse)?.datasets
      setExperiments(Array.isArray(experimentList) ? experimentList as Experiment[] : [])
      const nextDatasets = Array.isArray(datasetList) ? datasetList as EvalDataset[] : []
      setDatasets(nextDatasets)
      setRunForm((current) => current.evalDatasetId || nextDatasets.length === 0
        ? current
        : { ...current, evalDatasetId: nextDatasets[0]!.id })
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [platformVersion])

  async function selectExperiment(experiment: Experiment): Promise<void> {
    const requestId = detailRequestId.current + 1
    detailRequestId.current = requestId
    setSelected(experiment)
    setDetailLoading(true)
    try {
      const response = asRecord(await api(`/experiments/${encodeURIComponent(experiment.id)}`))
      const detail = response?.experiment as Experiment | undefined
      if (detail && requestId === detailRequestId.current) {
        setSelected(detail)
        setExperiments((current) => updateExperiment(current, detail))
      }
    } catch (error) {
      if (requestId === detailRequestId.current) addToast(tApiError(error), 'error')
    } finally {
      if (requestId === detailRequestId.current) setDetailLoading(false)
    }
  }

  async function createDataset(): Promise<void> {
    const name = datasetName.trim()
    if (!name) return
    setCreatingDataset(true)
    try {
      const response = asRecord(await api('/eval/datasets', {
        method: 'POST',
        body: JSON.stringify({ name, ...(datasetDescription.trim() ? { description: datasetDescription.trim() } : {}) }),
      }))
      const dataset = response?.dataset as EvalDataset | undefined
      if (!dataset) throw new Error(t('experiments.toast.datasetError'))
      setDatasets((current) => [dataset, ...current.filter((item) => item.id !== dataset.id)])
      setRunForm((current) => ({ ...current, evalDatasetId: dataset.id }))
      setDatasetName('')
      setDatasetDescription('')
      addToast(t('experiments.toast.datasetCreated'), 'success')
      bumpPlatformVersion()
    } catch (error) {
      addToast(tApiError(error) || t('experiments.toast.datasetError'), 'error')
    } finally {
      setCreatingDataset(false)
    }
  }

  async function runExperiment(): Promise<void> {
    if (!runForm.name.trim() || !runForm.controlRef.trim() || !runForm.candidateRef.trim() || !runForm.evalDatasetId) return
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
          ...(runForm.scorerKind === 'llm_judge' && runForm.judgeModelHint.trim()
            ? { judgeModelHint: runForm.judgeModelHint.trim() }
            : {}),
        }),
      }))
      const experiment = response?.experiment as Experiment | undefined
      const summary = response?.summary
      if (!experiment) throw new Error(t('experiments.toast.runError'))
      const completed = { ...experiment, summaryJson: summary ?? experiment.summaryJson }
      detailRequestId.current += 1
      setExperiments((current) => updateExperiment(current, completed))
      setSelected(completed)
      addToast(t('experiments.toast.runCompleted'), 'success')
      bumpPlatformVersion()
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

  const canRun = Boolean(runForm.name.trim() && runForm.controlRef.trim() && runForm.candidateRef.trim() && runForm.evalDatasetId)

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
        <div className="we-experiments__form">
          <label className="field-label" htmlFor="experiment-name">{t('experiments.field.name')}</label>
          <input id="experiment-name" className="text-field" value={runForm.name} onChange={(event) => setRunForm((current) => ({ ...current, name: event.target.value }))} />
          <label className="field-label" htmlFor="experiment-kind">{t('experiments.field.kind')}</label>
          <select id="experiment-kind" className="text-field" value={runForm.kind} onChange={(event) => setRunForm((current) => ({ ...current, kind: event.target.value as ExperimentKind }))}>
            <option value="prompt">{t('experiments.kind.prompt')}</option>
            <option value="model">{t('experiments.kind.model')}</option>
            <option value="prompt_and_model">{t('experiments.kind.promptAndModel')}</option>
          </select>
          <p className="helper-text we-experiments__ref-hint">{t(`experiments.refHint.${runForm.kind}`)}</p>
          <label className="field-label" htmlFor="experiment-control">{t('experiments.field.control')}</label>
          <input id="experiment-control" className="text-field" value={runForm.controlRef} onChange={(event) => setRunForm((current) => ({ ...current, controlRef: event.target.value }))} />
          <label className="field-label" htmlFor="experiment-candidate">{t('experiments.field.candidate')}</label>
          <input id="experiment-candidate" className="text-field" value={runForm.candidateRef} onChange={(event) => setRunForm((current) => ({ ...current, candidateRef: event.target.value }))} />
          <label className="field-label" htmlFor="experiment-dataset">{t('experiments.field.dataset')}</label>
          <select id="experiment-dataset" className="text-field" value={runForm.evalDatasetId} onChange={(event) => setRunForm((current) => ({ ...current, evalDatasetId: event.target.value }))}>
            <option value="">{t('experiments.dataset.placeholder')}</option>
            {datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{t('experiments.dataset.option', { name: dataset.name, count: dataset.exampleCount })}</option>)}
          </select>
          <label className="field-label" htmlFor="experiment-scorer">{t('experiments.field.scorer')}</label>
          <select id="experiment-scorer" className="text-field" value={runForm.scorerKind} onChange={(event) => setRunForm((current) => ({ ...current, scorerKind: event.target.value as RunForm['scorerKind'] }))}>
            <option value="string_equality">{t('experiments.scorer.stringEquality')}</option>
            <option value="json_schema">{t('experiments.scorer.jsonSchema')}</option>
            <option value="llm_judge">{t('experiments.scorer.llmJudge')}</option>
          </select>
          {runForm.scorerKind === 'llm_judge' && (
            <>
              <label className="field-label" htmlFor="experiment-judge-model">{t('experiments.field.judgeModel')}</label>
              <input id="experiment-judge-model" className="text-field" value={runForm.judgeModelHint} onChange={(event) => setRunForm((current) => ({ ...current, judgeModelHint: event.target.value }))} />
            </>
          )}
        </div>
        <div className="form-actions">
          <button type="button" className="we-button we-button--primary" onClick={() => void runExperiment()} disabled={!canRun || running}>
            <Play size={14} aria-hidden="true" />
            {running ? t('experiments.action.running') : t('experiments.action.run')}
          </button>
        </div>
      </section>

      <section className="we-card" aria-labelledby="experiments-dataset-title">
        <div className="we-card__header">
          <div>
            <div className="section-kicker">{t('experiments.dataset.kicker')}</div>
            <h3 id="experiments-dataset-title">{t('experiments.dataset.title')}</h3>
          </div>
          <Plus size={18} aria-hidden="true" />
        </div>
        <p className="helper-text">{t('experiments.dataset.description')}</p>
        <div className="we-experiments__dataset-form">
          <label className="field-label" htmlFor="experiment-dataset-name">{t('experiments.dataset.name')}</label>
          <input id="experiment-dataset-name" className="text-field" value={datasetName} onChange={(event) => setDatasetName(event.target.value)} />
          <label className="field-label" htmlFor="experiment-dataset-description">{t('experiments.dataset.descriptionLabel')}</label>
          <input id="experiment-dataset-description" className="text-field" value={datasetDescription} onChange={(event) => setDatasetDescription(event.target.value)} />
          <button type="button" className="we-button" onClick={() => void createDataset()} disabled={!datasetName.trim() || creatingDataset}>
            <Plus size={14} aria-hidden="true" />
            {creatingDataset ? t('experiments.action.creatingDataset') : t('experiments.action.createDataset')}
          </button>
        </div>
      </section>

      <section className="we-card" aria-labelledby="experiments-history-title">
        <div className="we-card__header">
          <div>
            <div className="section-kicker">{t('experiments.history.kicker')}</div>
            <h3 id="experiments-history-title">{t('experiments.history.title')}</h3>
          </div>
          <button type="button" className="we-button we-button--ghost" onClick={() => bumpPlatformVersion()} aria-label={t('experiments.action.refresh')}>
            <RefreshCw size={14} aria-hidden="true" />
          </button>
        </div>
        {loading ? <p className="helper-text">{t('common.loading')}</p> : experiments.length === 0 ? (
          <EmptyView icon={<ChartNoAxesCombined size={22} />} title={t('experiments.history.empty.title')} body={t('experiments.history.empty.body')} />
        ) : (
          <ul className="we-experiments__list">
            {experiments.map((experiment) => {
              const date = formatDate(experiment.completedAt ?? experiment.createdAt)
              return (
                <li key={experiment.id}>
                  <button type="button" className="we-experiments__row" data-selected={selected?.id === experiment.id ? 'true' : 'false'} onClick={() => void selectExperiment(experiment)}>
                    <span>
                      <strong>{experiment.name}</strong>
                      <small>{date ?? t('common.unknown')}</small>
                    </span>
                    <span className="we-pill" data-tone="info">{t(`experiments.status.${experiment.status}`)}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {selected && <ExperimentSummaryDetail experiment={selected} loading={detailLoading} onCopyCandidate={() => void copyCandidateReference()} />}
    </div>
  )
}
