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
const INTRODUCERS = new Set(['of', 'for', 'workflow', 'flow', 'de', 'del', 'para', 'flujo'])
const MODIFIERS = new Set([
  'not', 'no', 'except', 'excluding', 'without', 'before', 'until',
  'sin', 'excepto', 'menos', 'antes', 'hasta', 'hace',
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
    // "last 24h" or "last 24 hours"; a bare "24h" could mean an age or a duration, so it is not read.
    const compact = /^(\d{1,3})(h|d)$/.exec(list[at + 1]?.norm ?? '')
    if (compact && Number(compact[1]) > 0) return { time: { kind: 'last', amount: Number(compact[1]), unit: compact[2] as 'h' | 'd' }, next: at + 2 }
    const amount = /^\d{1,3}$/.test(list[at + 1]?.norm ?? '') ? Number(list[at + 1].norm) : 0
    const unit = list[at + 2]?.norm ?? ''
    if (amount > 0 && HOUR_UNITS.has(unit)) return { time: { kind: 'last', amount, unit: 'h' }, next: at + 3 }
    if (amount > 0 && DAY_UNITS.has(unit)) return { time: { kind: 'last', amount, unit: 'd' }, next: at + 3 }
  }
  return null
}

function parseStatus(list: Word[], at: number): { status: RunStatus; next: number } | null {
  const word = list[at]?.norm ?? ''
  if (word === 'timed' && list[at + 1]?.norm === 'out') return { status: 'timed_out', next: at + 2 }
  const status = STATUS_WORDS.get(word)
  return status ? { status, next: at + 1 } : null
}

export function parseRunQuery(query: string, workflows: ReadonlyArray<{ id: string; name: string }>): ParsedRunQuery {
  const list = words(query)
  const index = workflowIndex(workflows)
  const chips: RunQueryChip[] = []
  const unparsed: string[] = []
  let mentionsRuns = false
  let introduced = false
  const has = (kind: RunQueryChip['kind']) => chips.some(chip => chip.kind === kind)
  const span = (from: number, to: number) => ({ start: list[from].start, end: list[to - 1].end })
  const keep = (from: number, to: number) => unparsed.push(query.slice(list[from].start, list[to - 1].end))
  const isVocabulary = (at: number) => {
    const norm = list[at].norm
    return RUN_NOUNS.has(norm) || STOP_WORDS.has(norm) || SINCE_WORDS.has(norm) || LAST_WORDS.has(norm)
      || MODIFIERS.has(norm) || parseTime(list, at) !== null || parseStatus(list, at) !== null
  }
  // The longest name or id at `at`; a one-word name that is also a filter word needs "of"/"de" before it.
  const workflowAt = (at: number, afterIntroducer: boolean) => {
    for (let size = Math.min(MAX_WORKFLOW_WORDS, list.length - at); size > 0; size -= 1) {
      const id = index.get(workflowSlug(list.slice(at, at + size).map(item => item.norm).join(' ')))
      if (id !== undefined && (size > 1 || afterIntroducer || !isVocabulary(at))) return { id, next: at + size }
    }
    return null
  }
  // A filter word ends an unknown name, except a status word in first place: "of failed payments" stays whole.
  const boundary = (at: number, statusEnds: boolean) => isVocabulary(at) && !STOP_WORDS.has(list[at].norm)
    && (statusEnds || parseStatus(list, at) === null)

  for (let at = 0; at < list.length;) {
    const word = list[at]
    const afterIntroducer = introduced
    if (!STOP_WORDS.has(word.norm) || INTRODUCERS.has(word.norm)) introduced = false

    if (MODIFIERS.has(word.norm)) {
      // Negations and relative phrasing are not supported, so the words they touch are not read either.
      const next = at + 1 < list.length
        ? workflowAt(at + 1, true)?.next ?? parseTime(list, at + 1)?.next ?? parseStatus(list, at + 1)?.next ?? at + 1
        : at + 1
      keep(at, next)
      at = next
      continue
    }
    const workflow = workflowAt(at, afterIntroducer)
    if (workflow) {
      if (workflow.id && !has('workflow')) chips.push({ kind: 'workflow', workflowId: workflow.id, ...span(at, workflow.next) })
      else keep(at, workflow.next)
      at = workflow.next
      continue
    }
    if (afterIntroducer && !boundary(at, false) && !STOP_WORDS.has(word.norm)) {
      // An unknown name after "of"/"de" is kept whole, up to the next filter word.
      let next = at + 1
      while (next < list.length && !boundary(next, true)) next += 1
      keep(at, next)
      at = next
      continue
    }
    const time = parseTime(list, at)
    if (time) {
      const ago = list[time.next]?.norm === 'ago'
      if (ago || has('time')) keep(at, time.next + (ago ? 1 : 0))
      else chips.push({ kind: 'time', time: time.time, ...span(at, time.next) })
      at = time.next + (ago ? 1 : 0)
      continue
    }
    const status = parseStatus(list, at)
    if (status) {
      if (has('status')) keep(at, status.next)
      else chips.push({ kind: 'status', status: status.status, ...span(at, status.next) })
      at = status.next
      continue
    }
    if (RUN_NOUNS.has(word.norm)) mentionsRuns = true
    else if (INTRODUCERS.has(word.norm)) introduced = true
    else if (word.norm && !STOP_WORDS.has(word.norm)) keep(at, at + 1)
    at += 1
  }

  // "run" alone or a bare workflow name stays a command search ("Run workflow", "Open workflow").
  const isRunQuery = chips.some(chip => chip.kind !== 'workflow') || (mentionsRuns && chips.length > 0)
  return { chips, unparsed, isRunQuery }
}

export type RunQueryPreset = 'today' | 'yesterday' | 'sinceYesterday' | 'last7d'

export const RUN_QUERY_PRESETS: ReadonlyArray<{ preset: RunQueryPreset; time: RunQueryTime }> = [
  { preset: 'today', time: { kind: 'today' } },
  { preset: 'yesterday', time: { kind: 'yesterday' } },
  { preset: 'sinceYesterday', time: { kind: 'since', anchor: 'yesterday' } },
  { preset: 'last7d', time: { kind: 'last', amount: 7, unit: 'd' } },
]

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
