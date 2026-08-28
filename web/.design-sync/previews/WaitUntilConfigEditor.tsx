import { WaitUntilConfigEditor } from '@janusly/web'

/**
 * Quick-config editor for a wait step. A step waits either a relative
 * `duration` or until an absolute `until` timestamp — the mode selector
 * decides which field is live. Durations are **ISO 8601** (`PT15M`, `PT2H`,
 * `P3D`), not shorthand like `15m`.
 */

/** Relative wait — the common case between polling attempts. */
export function RelativeDuration() {
  return (
    <WaitUntilConfigEditor nodeId="cool_off" config={{ duration: 'PT15M' }} onUpdate={() => {}} />
  )
}

/** Absolute wait — hold until a fixed instant. */
export function AbsoluteTimestamp() {
  return (
    <WaitUntilConfigEditor
      nodeId="hold_for_window"
      config={{ until: '2026-09-01T02:15:00Z' }}
      onUpdate={() => {}}
    />
  )
}

/** A fresh step with neither field set. */
export function Empty() {
  return <WaitUntilConfigEditor nodeId="wait_1" config={{}} onUpdate={() => {}} />
}
