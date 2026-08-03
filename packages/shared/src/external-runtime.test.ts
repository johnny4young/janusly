import { describe, expect, it } from 'vitest'

import {
  ExternalRuntimeEventSchema,
  parseExternalRuntimeEvent,
} from './external-runtime'

const runEvent = {
  specversion: '1.0',
  id: 'event-42',
  source: 'urn:temporal:payments',
  type: 'io.janusly.external.run.observed',
  time: '2026-07-27T12:30:00.000Z',
  datacontenttype: 'application/json',
  data: {
    externalWorkflowId: 'payment-reconciliation',
    externalRunId: 'run-42',
    sequence: 7,
    status: 'failed',
    evidence: [
      { kind: 'trace', label: 'Open trace', locator: 'trace-42' },
    ],
  },
} as const

describe('ExternalRuntimeEventSchema', () => {
  it('accepts a bounded CloudEvents-compatible run observation', () => {
    expect(parseExternalRuntimeEvent(runEvent)).toEqual(runEvent)
  })

  it('defaults bounded evidence and step attempt', () => {
    const parsed = parseExternalRuntimeEvent({
      specversion: '1.0',
      id: 'event-43',
      source: 'urn:dagster:warehouse',
      type: 'io.janusly.external.step.observed',
      time: '2026-07-27T12:31:00.000Z',
      data: {
        externalWorkflowId: 'daily-load',
        externalRunId: 'run-43',
        externalStepId: 'extract',
        name: 'Extract',
        sequence: 1,
        status: 'running',
      },
    })

    expect(parsed.data).toMatchObject({ evidence: [], attempt: 1 })
  })

  it('rejects control commands and unknown extensions', () => {
    expect(ExternalRuntimeEventSchema.safeParse({
      ...runEvent,
      retry: true,
    }).success).toBe(false)
    expect(ExternalRuntimeEventSchema.safeParse({
      ...runEvent,
      type: 'io.janusly.external.run.retry',
    }).success).toBe(false)
  })

  it('requires a deterministic source sequence', () => {
    const withoutSequence = structuredClone(runEvent) as Record<string, unknown>
    delete (withoutSequence.data as Record<string, unknown>).sequence
    expect(ExternalRuntimeEventSchema.safeParse(withoutSequence).success).toBe(false)
  })
})
