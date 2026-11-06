import { describe, expect, it } from 'vitest'
import { RUN_QUERY_TEXT, parseRunQuery, replaceRunQuerySpan, resolveRunQueryTime, workflowSlug } from './run-query'

const workflows = [
  { id: 'demo-flaky-ingest', name: 'Demo · flaky ingest' },
  { id: 'wf-1', name: 'Order pipeline' },
  { id: 'wf-2', name: 'Refund triage' },
  { id: 'wf-3', name: 'Refund triage' },
  { id: 'wf-4', name: 'Failed payment recovery' },
  { id: 'wf-5', name: 'Failed payment recovery' },
  { id: 'wf-6', name: 'Run' },
]

function summary(query: string) {
  const parsed = parseRunQuery(query, workflows)
  return {
    chips: parsed.chips.map(chip => chip.kind === 'status' ? `status=${chip.status}`
      : chip.kind === 'workflow' ? `workflow=${chip.workflowId}`
        : `time=${JSON.stringify(chip.time)}`),
    unparsed: parsed.unparsed,
    isRunQuery: parsed.isRunQuery,
  }
}

describe('parseRunQuery', () => {
  it('reads status, workflow and time from an English sentence', () => {
    expect(summary('failed runs of demo-flaky-ingest since yesterday')).toEqual({
      chips: ['status=failed', 'workflow=demo-flaky-ingest', 'time={"kind":"since","anchor":"yesterday"}'],
      unparsed: [],
      isRunQuery: true,
    })
  })

  it('reads the same filters from Spanish, accents included', () => {
    expect(summary('ejecuciones fallidas de demo-flaky-ingest desde ayer').chips)
      .toEqual(['status=failed', 'workflow=demo-flaky-ingest', 'time={"kind":"since","anchor":"yesterday"}'])
    expect(summary('ejecuciones exitosas desde el lunes').chips).toEqual(['status=succeeded', 'time={"kind":"since","anchor":1}'])
    expect(summary('fallidas en los últimos 7 días').chips).toEqual(['status=failed', 'time={"kind":"last","amount":7,"unit":"d"}'])
    expect(summary('canceladas hoy').chips).toEqual(['status=cancelled', 'time={"kind":"today"}'])
  })

  it('matches a workflow by its name typed as words', () => {
    expect(summary('runs of order pipeline yesterday').chips).toEqual(['workflow=wf-1', 'time={"kind":"yesterday"}'])
    expect(summary('timed out runs last 24 hours').chips).toEqual(['status=timed_out', 'time={"kind":"last","amount":24,"unit":"h"}'])
  })

  it('keeps unknown, ambiguous and repeated words visible instead of guessing', () => {
    const parsed = summary('failed succeeded runs of refund triage since lastweek banana')
    expect(parsed.chips).toEqual(['status=failed'])
    expect(parsed.unparsed).toEqual(['succeeded', 'refund triage', 'since', 'lastweek', 'banana'])
  })

  it('keeps an ambiguous, repeated or unknown workflow phrase whole instead of reading filters inside it', () => {
    expect(summary('runs of failed payment recovery')).toEqual({ chips: [], unparsed: ['failed payment recovery'], isRunQuery: false })
    expect(summary('failed payment recovery runs today').chips).toEqual(['time={"kind":"today"}'])
    expect(summary('runs of order pipeline of demo-flaky-ingest today')).toMatchObject({
      chips: ['workflow=wf-1', 'time={"kind":"today"}'], unparsed: ['demo-flaky-ingest'],
    })
    expect(summary('runs of failed billing sync since yesterday')).toEqual({
      chips: ['time={"kind":"since","anchor":"yesterday"}'], unparsed: ['failed billing sync'], isRunQuery: true,
    })
    expect(summary('failed run').chips).toEqual(['status=failed'])
    expect(summary('failed runs of run').chips).toEqual(['status=failed', 'workflow=wf-6'])
  })

  it('leaves negated, relative and zero-length time out instead of applying it', () => {
    expect(summary('not failed runs')).toEqual({ chips: [], unparsed: ['not failed'], isRunQuery: false })
    expect(summary('ejecuciones no fallidas hoy')).toMatchObject({ chips: ['time={"kind":"today"}'], unparsed: ['no fallidas'] })
    expect(summary('failed runs 2d ago').chips).toEqual(['status=failed'])
    expect(summary('failed runs since 1d').unparsed).toEqual(['since', '1d'])
    expect(summary('failed runs last 0d').unparsed).toEqual(['last', '0d'])
    expect(summary('failed runs last 7 days ago')).toMatchObject({ chips: ['status=failed'], unparsed: ['last 7 days ago'] })
    expect(summary('failed runs last 24h').chips).toEqual(['status=failed', 'time={"kind":"last","amount":24,"unit":"h"}'])
  })

  it('never reads object prototype keys as vocabulary', () => {
    expect(summary('constructor runs since tostring')).toEqual({ chips: [], unparsed: ['constructor', 'since', 'tostring'], isRunQuery: false })
  })

  it('leaves command searches alone', () => {
    expect(summary('run').isRunQuery).toBe(false)
    expect(summary('order pipeline').isRunQuery).toBe(false)
    expect(summary('runs of order pipeline').isRunQuery).toBe(true)
  })

  it('parses every canonical edit value back to itself', () => {
    for (const text of Object.values(RUN_QUERY_TEXT)) {
      for (const [status, word] of Object.entries(text.status)) {
        expect(summary(`runs ${word}`).chips).toEqual([`status=${status}`])
      }
      for (const word of Object.values(text.time)) {
        expect(summary(word).chips).toHaveLength(1)
      }
    }
  })
})

describe('resolveRunQueryTime', () => {
  const now = new Date(2026, 10, 6, 15, 30) // Friday
  it('resolves local day boundaries', () => {
    expect(resolveRunQueryTime({ kind: 'yesterday' }, now)).toEqual({ from: new Date(2026, 10, 5).getTime(), to: new Date(2026, 10, 6).getTime() })
    expect(resolveRunQueryTime({ kind: 'since', anchor: 1 }, now)).toEqual({ from: new Date(2026, 10, 2).getTime() })
    expect(resolveRunQueryTime({ kind: 'since', anchor: 5 }, now)).toEqual({ from: new Date(2026, 10, 6).getTime() })
    expect(resolveRunQueryTime({ kind: 'last', amount: 2, unit: 'h' }, now)).toEqual({ from: now.getTime() - 7_200_000 })
  })
})

describe('chip edits', () => {
  it('rewrites or removes only the chip words', () => {
    const query = 'failed runs of demo-flaky-ingest since yesterday'
    const [status, workflow] = parseRunQuery(query, workflows).chips
    expect(replaceRunQuerySpan(query, status, 'succeeded')).toBe('succeeded runs of demo-flaky-ingest since yesterday')
    expect(replaceRunQuerySpan(query, workflow, '')).toBe('failed runs of since yesterday')
    expect(workflowSlug('Demo · flaky ingest')).toBe('demo-flaky-ingest')
  })
})
