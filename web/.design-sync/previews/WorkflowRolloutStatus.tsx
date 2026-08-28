import { WorkflowRolloutStatus } from '@janusly/web'

/**
 * The canary rollout panel: how much traffic the new version is taking, how
 * it is performing against the baseline, and whether the gates
 * (`minimumSampleSize`, `minimumSuccessRatePercent`) are satisfied yet.
 * `readOnly` reflects permissions; `mutating` disables the buttons in flight.
 */

/** A canary still gathering evidence — below the minimum sample size. */
export function GatheringEvidence() {
  return (
    <WorkflowRolloutStatus
      status="active"
      trafficPercent={10}
      minimumSampleSize={200}
      minimumSuccessRatePercent={98}
      baselineVersion={7}
      canaryVersion={8}
      baselineRuns={1840}
      canaryRuns={64}
      canarySuccessRate={99.1}
      readOnly={false}
      mutating={false}
      onDecide={() => {}}
    />
  )
}

/** Gates met and the canary is winning — promotion is available. */
export function ReadyToPromote() {
  return (
    <WorkflowRolloutStatus
      status="active"
      trafficPercent={50}
      minimumSampleSize={200}
      minimumSuccessRatePercent={98}
      baselineVersion={7}
      canaryVersion={8}
      baselineRuns={2400}
      canaryRuns={2380}
      canarySuccessRate={99.6}
      readOnly={false}
      mutating={false}
      onDecide={() => {}}
    />
  )
}

/** The canary is underperforming its gate. */
export function FailingGate() {
  return (
    <WorkflowRolloutStatus
      status="active"
      trafficPercent={25}
      minimumSampleSize={200}
      minimumSuccessRatePercent={98}
      baselineVersion={7}
      canaryVersion={8}
      baselineRuns={2100}
      canaryRuns={640}
      canarySuccessRate={91.2}
      readOnly={false}
      mutating={false}
      onDecide={() => {}}
    />
  )
}

/** Already promoted — a terminal state with no decision left. */
export function Promoted() {
  return (
    <WorkflowRolloutStatus
      status="promoted"
      trafficPercent={100}
      minimumSampleSize={200}
      minimumSuccessRatePercent={98}
      baselineVersion={7}
      canaryVersion={8}
      baselineRuns={2400}
      canaryRuns={2400}
      canarySuccessRate={99.6}
      readOnly={false}
      mutating={false}
      onDecide={() => {}}
    />
  )
}

/** Rolled back, viewed by an operator without rollout permissions. */
export function RolledBackReadOnly() {
  return (
    <WorkflowRolloutStatus
      status="rolled_back"
      trafficPercent={0}
      minimumSampleSize={200}
      minimumSuccessRatePercent={98}
      baselineVersion={7}
      canaryVersion={8}
      baselineRuns={2100}
      canaryRuns={640}
      canarySuccessRate={91.2}
      readOnly
      mutating={false}
      onDecide={() => {}}
    />
  )
}
