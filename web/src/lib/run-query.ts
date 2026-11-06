/**
 * Deterministic EN/ES parser that turns a palette query into the filters the
 * bounded `/runs` endpoint accepts (status, workflow) plus a time range the
 * client applies while paging newest-first. Words it does not know stay in
 * `unparsed`; a duplicate or ambiguous filter is never resolved by guessing.
 */
import type { RunStatus } from './status'

export type RunQueryTime =
  | { kind: 'today' }
  | { kind: 'yesterday' }
  | { kind: 'since'; anchor: 'today' | 'yesterday' | number }
  | { kind: 'last'; amount: number; unit: 'h' | 'd' }

export type RunQueryChip = { start: number; end: number } & (
  | { kind: 'status'; status: RunStatus }
  | { kind: 'workflow'; workflowId: string }
  | { kind: 'time'; time: RunQueryTime }
)

export type ParsedRunQuery = {
  chips: RunQueryChip[]
  unparsed: string[]
  /** True when the query reads as a run search rather than a command search. */
  isRunQuery: boolean
}

type Word = { norm: string; start: number; end: number }

const RUN_NOUNS = new Set(['run', 'runs', 'ejecucion', 'ejecuciones', 'corrida', 'corridas'])
const STOP_WORDS = new Set([
  'of', 'for', 'in', 'on', 'the', 'with', 'and', 'all', 'show', 'me', 'find', 'workflow', 'flow',
  'de', 'del', 'en', 'para', 'el', 'la', 'los', 'las', 'con', 'y', 'todas', 'todos', 'ver', 'flujo',
])
const SINCE_WORDS = new Set(['since', 'from', 'after', 'desde'])
const LAST_WORDS = new Set(['last', 'past', 'ultimo', 'ultimos', 'ultima', 'ultimas'])
const HOUR_UNITS = new Set(['h', 'hour', 'hours', 'hora', 'horas'])
const DAY_UNITS = new Set(['d', 'day', 'days', 'dia', 'dias'])
const WEEKDAYS = new Map<string, number>(Object.entries({
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
  domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6,
}))
const STATUS_WORDS = new Map<string, RunStatus>(Object.entries({
  failed: 'failed', failing: 'failed', failure: 'failed', failures: 'failed',
  fallida: 'failed', fallidas: 'failed', fallido: 'failed', fallidos: 'failed', fallaron: 'failed',
  succeeded: 'succeeded', successful: 'succeeded', exitosa: 'succeeded', exitosas: 'succeeded', exitoso: 'succeeded', exitosos: 'succeeded',
  running: 'running', corriendo: 'running', ejecutandose: 'running',
  waiting: 'waiting', esperando: 'waiting',
  cancelled: 'cancelled', canceled: 'cancelled', cancelada: 'cancelled', canceladas: 'cancelled', cancelado: 'cancelled', cancelados: 'cancelled',
  timed_out: 'timed_out', timeout: 'timed_out', 'timed-out': 'timed_out', vencida: 'timed_out', vencidas: 'timed_out',
} satisfies Record<string, RunStatus>))
const MAX_WORKFLOW_WORDS = 6

function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
}

/** Name or id as one hyphenated token: "Demo · flaky ingest" → "demo-flaky-ingest". */
export function workflowSlug(value: string): string {
  return fold(value).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '')
}

function words(query: string): Word[] {
  return [...query.matchAll(/\S+/g)].map(match => ({
    norm: fold(match[0]).replace(/^[,.;:!?"']+|[,.;:!?"']+$/g, ''),
    start: match.index,
    end: match.index + match[0].length,
  }))
}

function workflowIndex(workflows: ReadonlyArray<{ id: string; name: string }>): Map<string, string | null> {
  const index = new Map<string, string | null>()
  const add = (key: string, id: string) => {
    if (!key) return
    const existing = index.get(key)
    index.set(key, existing === undefined || existing === id ? id : null)
  }
  for (const workflow of workflows) {
    add(workflowSlug(workflow.id), workflow.id)
    add(workflowSlug(workflow.name), workflow.id)
  }
  return index
}

function parseTime(list: Word[], at: number): { time: RunQueryTime; next: number } | null {
  const word = list[at]?.norm
  if (!word) return null
  if (word === 'today' || word === 'hoy') return { time: { kind: 'today' }, next: at + 1 }
  if (word === 'yesterday' || word === 'ayer') return { time: { kind: 'yesterday' }, next: at + 1 }
  const compact = /^(\d{1,3})(h|d)$/.exec(word)
  if (compact) return { time: { kind: 'last', amount: Number(compact[1]), unit: compact[2] as 'h' | 'd' }, next: at + 1 }
  if (SINCE_WORDS.has(word)) {
    let cursor = at + 1
    while (list[cursor] && STOP_WORDS.has(list[cursor].norm)) cursor += 1
    const anchor = list[cursor]?.norm
    if (anchor === 'today' || anchor === 'hoy') return { time: { kind: 'since', anchor: 'today' }, next: cursor + 1 }
    if (anchor === 'yesterday' || anchor === 'ayer') return { time: { kind: 'since', anchor: 'yesterday' }, next: cursor + 1 }
    const weekday = anchor === undefined ? undefined : WEEKDAYS.get(anchor)
    if (weekday !== undefined) return { time: { kind: 'since', anchor: weekday }, next: cursor + 1 }
    return null
  }
  if (LAST_WORDS.has(word)) {
    const amount = /^\d{1,3}$/.test(list[at + 1]?.norm ?? '') ? Number(list[at + 1].norm) : null
    const unit = list[at + 2]?.norm ?? ''
    if (amount && HOUR_UNITS.has(unit)) return { time: { kind: 'last', amount, unit: 'h' }, next: at + 3 }
    if (amount && DAY_UNITS.has(unit)) return { time: { kind: 'last', amount, unit: 'd' }, next: at + 3 }
  }
  return null
}

export function parseRunQuery(query: string, workflows: ReadonlyArray<{ id: string; name: string }>): ParsedRunQuery {
  const list = words(query)
  const index = workflowIndex(workflows)
  const chips: RunQueryChip[] = []
  const unparsed: string[] = []
  let mentionsRuns = false
  const has = (kind: RunQueryChip['kind']) => chips.some(chip => chip.kind === kind)

  for (let at = 0; at < list.length;) {
    const word = list[at]
    let workflowEnd = -1
    let workflowId: string | null = null
    for (let size = Math.min(MAX_WORKFLOW_WORDS, list.length - at); size > 0 && workflowEnd < 0; size -= 1) {
      const match = index.get(workflowSlug(list.slice(at, at + size).map(item => item.norm).join(' ')))
      if (match !== undefined) {
        workflowEnd = at + size
        workflowId = match
      }
    }
    if (workflowEnd > 0 && workflowId && !has('workflow')) {
      chips.push({ kind: 'workflow', workflowId, start: word.start, end: list[workflowEnd - 1].end })
      at = workflowEnd
      continue
    }
    const time = parseTime(list, at)
    if (time && !has('time')) {
      chips.push({ kind: 'time', time: time.time, start: word.start, end: list[time.next - 1].end })
      at = time.next
      continue
    }
    const status = STATUS_WORDS.get(word.norm) ?? (word.norm === 'timed' && list[at + 1]?.norm === 'out' ? 'timed_out' : undefined)
    const statusEnd = word.norm === 'timed' ? at + 2 : at + 1
    if (status && !has('status')) {
      chips.push({ kind: 'status', status, start: word.start, end: list[statusEnd - 1].end })
      at = statusEnd
      continue
    }
    if (RUN_NOUNS.has(word.norm)) mentionsRuns = true
    else if (word.norm && !STOP_WORDS.has(word.norm)) unparsed.push(query.slice(word.start, word.end))
    at += 1
  }

  // "run" alone or a bare workflow name stays a command search ("Run workflow", "Open workflow").
  const isRunQuery = chips.some(chip => chip.kind !== 'workflow') || (mentionsRuns && chips.length > 0)
  return { chips, unparsed, isRunQuery }
}

export type RunQueryPreset = 'today' | 'yesterday' | 'sinceYesterday' | 'last7d'

/** Words that parse back to each editable value, in the operator's language. */
export const RUN_QUERY_TEXT = {
  en: {
    status: { failed: 'failed', succeeded: 'succeeded', running: 'running', waiting: 'waiting', cancelled: 'cancelled', timed_out: 'timed out' },
    time: { today: 'today', yesterday: 'yesterday', sinceYesterday: 'since yesterday', last7d: 'last 7 days' },
  },
  es: {
    status: { failed: 'fallidas', succeeded: 'exitosas', running: 'corriendo', waiting: 'esperando', cancelled: 'canceladas', timed_out: 'vencidas' },
    time: { today: 'hoy', yesterday: 'ayer', sinceYesterday: 'desde ayer', last7d: 'últimos 7 días' },
  },
} satisfies Record<'en' | 'es', { status: Record<Exclude<RunStatus, 'created'>, string>; time: Record<RunQueryPreset, string> }>

function startOfDay(at: Date, daysBack = 0): number {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() - daysBack).getTime()
}

/** The `[from, to)` window in epoch ms; `to` is absent for open-ended ranges. */
export function resolveRunQueryTime(time: RunQueryTime, now: Date): { from: number; to?: number } {
  switch (time.kind) {
    case 'today': return { from: startOfDay(now) }
    case 'yesterday': return { from: startOfDay(now, 1), to: startOfDay(now) }
    case 'last': return { from: now.getTime() - time.amount * (time.unit === 'h' ? 3_600_000 : 86_400_000) }
    case 'since':
      if (time.anchor === 'today') return { from: startOfDay(now) }
      if (time.anchor === 'yesterday') return { from: startOfDay(now, 1) }
      return { from: startOfDay(now, (now.getDay() - time.anchor + 7) % 7) }
  }
}

/** Rewrite one chip's words in the query; an empty replacement removes the chip. */
export function replaceRunQuerySpan(query: string, chip: Pick<RunQueryChip, 'start' | 'end'>, replacement: string): string {
  return `${query.slice(0, chip.start)}${replacement}${query.slice(chip.end)}`.replace(/\s{2,}/g, ' ').trim()
}
