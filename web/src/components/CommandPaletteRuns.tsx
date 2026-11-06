import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { runStatusValues, type RunStatus } from '@/lib/status'
import { formatStatusLabel } from '../constants'
import { getResolvedLocale, useT } from '../i18n'
import { readRunSummaryPage } from '../lib/list-contract'
import {
  RUN_QUERY_TEXT,
  replaceRunQuerySpan,
  resolveRunQueryTime,
  workflowSlug,
  type ParsedRunQuery,
  type RunQueryChip,
  type RunQueryPreset,
} from '../lib/run-query'
import type { RunSummary } from '../types'

const PAGE_SIZE = 25
const PRESETS: RunQueryPreset[] = ['today', 'yesterday', 'sinceYesterday', 'last7d']

export type PaletteRunRequest = { status?: RunStatus; workflowId?: string; from?: number; to?: number }

type Results = { key: string; kind: 'loading' | 'ready' | 'error'; runs: RunSummary[]; next?: string; more?: boolean }

export function runRequestFor(parsed: ParsedRunQuery, now: Date): PaletteRunRequest {
  const request: PaletteRunRequest = {}
  for (const chip of parsed.chips) {
    if (chip.kind === 'status') request.status = chip.status
    else if (chip.kind === 'workflow') request.workflowId = chip.workflowId
    else Object.assign(request, resolveRunQueryTime(chip.time, now))
  }
  return request
}

/** Newest-first pages of the org-scoped `/runs` list; the time window is applied here because the API has none. */
export function usePaletteRunResults(request: PaletteRunRequest | null) {
  const key = request ? JSON.stringify(request) : ''
  const [results, setResults] = useState<Results>({ key: '', kind: 'loading', runs: [] })
  const pending = useRef<AbortController | null>(null)

  const fetchPage = useCallback((cursor?: string) => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller
    const { status, workflowId, from, to } = JSON.parse(key) as PaletteRunRequest
    const params = new URLSearchParams({ limit: String(PAGE_SIZE) })
    if (status) params.set('status', status)
    if (workflowId) params.set('workflowId', workflowId)
    if (cursor) params.set('before', cursor)
    readRunSummaryPage(`/runs?${params}`, controller.signal).then(rows => {
      if (controller.signal.aborted) return
      const at = (row: RunSummary) => Date.parse(row.createdAt ?? '')
      const last = rows.at(-1)
      const next = rows.length === PAGE_SIZE && last?.createdAt && (from === undefined || at(last) >= from)
        ? `${last.createdAt}|${last.id}`
        : undefined
      const page = rows.filter(row => (from === undefined || at(row) >= from) && (to === undefined || at(row) < to))
      setResults(previous => ({ key, kind: 'ready', runs: cursor && previous.key === key ? [...previous.runs, ...page] : page, next }))
    }).catch(() => {
      if (!controller.signal.aborted) setResults({ key, kind: 'error', runs: [] })
    })
  }, [key])

  useEffect(() => {
    if (!key) return
    const timer = window.setTimeout(() => fetchPage(), 200)
    return () => {
      window.clearTimeout(timer)
      pending.current?.abort()
    }
  }, [fetchPage, key])

  const current: Results = results.key === key ? results : { key, kind: 'loading', runs: [] }
  const loadMore = () => {
    if (!current.next || current.more) return
    setResults({ ...current, more: true })
    fetchPage(current.next)
  }
  return { ...current, loading: current.kind === 'loading' || Boolean(current.more), loadMore }
}

/** Short local date, with the time when the moment matters. */
export function formatRunTime(at: number, withTime = true): string {
  return new Intl.DateTimeFormat(getResolvedLocale(), withTime
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric' }).format(at)
}

export function PaletteRunFilters({ query, parsed, workflows, now, onQueryChange }: {
  query: string
  parsed: ParsedRunQuery
  workflows: ReadonlyArray<{ id: string; name: string }>
  now: Date
  /** `removed` hands focus back to the query, since the pressed chip is gone. */
  onQueryChange: (next: string, removed?: boolean) => void
}) {
  const { t, i18n } = useT()
  const text = RUN_QUERY_TEXT[i18n.language === 'es' ? 'es' : 'en']
  // A name slug shared with any other name or id cannot round-trip, so it is written as the id.
  const workflowText = useMemo(() => {
    const counts = new Map<string, number>()
    for (const slug of workflows.flatMap(workflow => [workflowSlug(workflow.id), workflowSlug(workflow.name)])) counts.set(slug, (counts.get(slug) ?? 0) + 1)
    return (workflow: { id: string; name: string }) => counts.get(workflowSlug(workflow.name)) === 1 ? workflowSlug(workflow.name) : workflow.id
  }, [workflows])

  const chipControl = (chip: RunQueryChip) => {
    const current = query.slice(chip.start, chip.end)
    if (chip.kind === 'status') {
      return {
        value: current,
        options: runStatusValues.filter((status): status is Exclude<RunStatus, 'created'> => status !== 'created')
          .map(status => ({ value: status === chip.status ? current : text.status[status], label: formatStatusLabel(status) })),
      }
    }
    if (chip.kind === 'workflow') {
      return {
        value: current,
        options: workflows.map(workflow => ({ value: workflow.id === chip.workflowId ? current : workflowText(workflow), label: workflow.name })),
      }
    }
    const range = resolveRunQueryTime(chip.time, now)
    const label = range.to !== undefined
      ? t('palette.runs.time.on', { date: formatRunTime(range.from, false) })
      : t('palette.runs.time.since', { date: formatRunTime(range.from) })
    const presets = PRESETS.map(preset => ({ value: text.time[preset], label: t(`palette.runs.preset.${preset}`) }))
    return { value: current, options: [{ value: current, label }, ...presets.filter(preset => preset.value !== current)] }
  }

  return (
    <div className="we-cmdk-filters" role="group" aria-label={t('palette.runs.filters')} data-testid="palette-run-filters">
      {parsed.chips.map(chip => {
        const control = chipControl(chip)
        const name = t(`palette.runs.chip.${chip.kind}`)
        return (
          <span key={chip.kind} className="we-cmdk-chip" data-testid={`palette-chip-${chip.kind}`}>
            <select
              aria-label={name}
              value={control.value}
              onChange={event => onQueryChange(replaceRunQuerySpan(query, chip, event.target.value))}
              data-testid={`palette-chip-select-${chip.kind}`}
            >
              {control.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
            <button
              type="button"
              aria-label={t('palette.runs.remove', { filter: name })}
              onClick={() => onQueryChange(replaceRunQuerySpan(query, chip, ''), true)}
              data-testid={`palette-chip-remove-${chip.kind}`}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </span>
        )
      })}
      {parsed.unparsed.length > 0 && (
        <span className="we-cmdk-unparsed" data-testid="palette-unparsed">
          {t('palette.runs.unparsed', { words: parsed.unparsed.join(' ') })}
        </span>
      )}
    </div>
  )
}
