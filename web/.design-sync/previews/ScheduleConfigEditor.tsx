import { ScheduleConfigEditor } from '@janusly/web'

/**
 * Quick-config editor for a cron-scheduled step. The editor validates the
 * expression as you type and surfaces its own invalid state, so both a valid
 * and an unparseable expression are worth seeing.
 */

/** A nightly schedule. */
export function Nightly() {
  return (
    <ScheduleConfigEditor
      nodeId="nightly_reconciliation"
      config={{ cronExpression: '0 2 * * *' }}
      onUpdate={() => {}}
    />
  )
}

/** Every 15 minutes during business hours, weekdays only. */
export function BusinessHours() {
  return (
    <ScheduleConfigEditor
      nodeId="intraday_sync"
      config={{ cronExpression: '*/15 9-17 * * 1-5' }}
      onUpdate={() => {}}
    />
  )
}

/** An expression the parser rejects — the invalid state. */
export function InvalidExpression() {
  return (
    <ScheduleConfigEditor
      nodeId="broken_schedule"
      config={{ cronExpression: 'every night at 2' }}
      onUpdate={() => {}}
    />
  )
}

/** A fresh step, nothing scheduled yet. */
export function Empty() {
  return <ScheduleConfigEditor nodeId="schedule_1" config={{}} onUpdate={() => {}} />
}
