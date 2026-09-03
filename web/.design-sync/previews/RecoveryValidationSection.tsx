import { RecoveryValidationSection } from '@janusly/web'
import { validationReport } from './_fixtures'

/**
 * Does recovery actually work here? The section reports drill outcomes over a
 * window, split by failure mode, with the operator-intervention rate and the
 * elapsed-time distribution.
 *
 * `report` carries three states the emitted `.d.ts` flattens away: a report,
 * `undefined` while loading, and `null` after a soft read failure. All three
 * are shown, because the difference between "no data yet" and "we could not
 * read it" is the whole point of the null case.
 */

/** A workspace with a healthy drill record. */
export function WithReport() {
  return <RecoveryValidationSection report={validationReport} />
}

/** Loading — `undefined`. */
export function Loading() {
  return <RecoveryValidationSection report={undefined as never} />
}

/** Soft read failure — `null`, deliberately distinct from loading. */
export function ReadFailed() {
  return <RecoveryValidationSection report={null as never} />
}
