import { RecoveryDrillOutcomeCard } from '@janusly/web'

/**
 * The result of a recovery drill. `evidence` is what makes the outcome
 * trustworthy — a drill that ends without either terminal impact or an
 * explicit resolution is reported as `measurement_incomplete` rather than as
 * a success, and `recurrence` tracks whether the same signature came back
 * inside the watch window.
 */

/** A clean recovery, with the recurrence window still being watched. */
export function Recovered() {
  return (
    <RecoveryDrillOutcomeCard
      outcome={{
        status: 'recovered',
        startedAt: '2026-08-26T02:00:00.000Z',
        completedAt: '2026-08-26T02:07:41.000Z',
        elapsedMs: 461000,
        evidence: 'terminal_impact',
        attemptCount: 2,
        latestDeadLetterId: 'dlq_4f2a91',
        chainCapped: false,
        recurrence: { status: 'monitoring', windowEndsAt: '2026-09-02T02:07:41.000Z', recurredAt: null },
      }}
    />
  )
}

/** Waiting on an operator decision. */
export function AwaitingAction() {
  return (
    <RecoveryDrillOutcomeCard
      outcome={{
        status: 'awaiting_action',
        startedAt: '2026-08-27T14:12:00.000Z',
        completedAt: null,
        elapsedMs: null,
        evidence: null,
        attemptCount: 0,
        latestDeadLetterId: 'dlq_8c31d0',
        chainCapped: false,
        recurrence: { status: 'not_applicable', windowEndsAt: null, recurredAt: null },
      }}
    />
  )
}

/** The honest non-answer: it finished, but nothing proved the outcome. */
export function MeasurementIncomplete() {
  return (
    <RecoveryDrillOutcomeCard
      outcome={{
        status: 'measurement_incomplete',
        startedAt: '2026-08-25T09:30:00.000Z',
        completedAt: '2026-08-25T09:48:12.000Z',
        elapsedMs: 1092000,
        evidence: null,
        attemptCount: 4,
        latestDeadLetterId: 'dlq_1b77ae',
        chainCapped: true,
        recurrence: { status: 'not_applicable', windowEndsAt: null, recurredAt: null },
      }}
    />
  )
}

/** Recovered, then the same signature came back inside the window. */
export function Recurred() {
  return (
    <RecoveryDrillOutcomeCard
      outcome={{
        status: 'recovered',
        startedAt: '2026-08-20T02:00:00.000Z',
        completedAt: '2026-08-20T02:05:03.000Z',
        elapsedMs: 303000,
        evidence: 'explicit_resolution',
        attemptCount: 1,
        latestDeadLetterId: 'dlq_02de55',
        chainCapped: false,
        recurrence: { status: 'recurred', windowEndsAt: '2026-08-27T02:05:03.000Z', recurredAt: '2026-08-24T02:11:00.000Z' },
      }}
    />
  )
}

/** The loss was accepted rather than recovered. */
export function AcceptedLoss() {
  return (
    <RecoveryDrillOutcomeCard
      outcome={{
        status: 'accepted_loss',
        startedAt: '2026-08-22T18:00:00.000Z',
        completedAt: '2026-08-22T18:26:40.000Z',
        elapsedMs: 1600000,
        evidence: 'explicit_resolution',
        attemptCount: 3,
        latestDeadLetterId: 'dlq_77ab21',
        chainCapped: false,
        recurrence: { status: 'clear', windowEndsAt: '2026-08-29T18:26:40.000Z', recurredAt: null },
      }}
    />
  )
}
