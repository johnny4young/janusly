import { RecoveryCenterView } from '@janusly/web'
import {
  NOW_MS,
  clustersResponse,
  deadLetter,
  heatmapCells,
  heatmapDays,
  operatorWins,
  recoveryLedger,
  recoveryMetrics,
  runSummary,
  validationReport,
} from './_fixtures'

/**
 * Home — the screen an operator lands on. Like the workflows dashboard it is
 * the presentational half of a controller/view pair, so everything arrives in
 * one `model` object rather than as individual props.
 *
 * The screen answers one question in order: how healthy is this workspace
 * (`healthScore`, `streak`, `longestOpen`), what should I do next
 * (`recommendedActions`, ordered by severity), and what is the evidence
 * (`HomeInsights`, collapsed behind `insightsOpen`).
 *
 * `allClear` and `recoveryClearEligible` are both required for the celebration
 * state — a workspace with an empty queue that has not earned the all-clear
 * still shows the ordinary hero. That deliberate pairing is why the all-clear
 * story sets both.
 *
 * `insightsOpen` stays `false` here: the insights section is `lazy`-loaded
 * behind a `Suspense`, and a static capture of the expanded state lands on the
 * fallback rather than the content. `HomeInsights` has its own card.
 */

const noop = () => {}

const base = {
  activeRuns: [runSummary],
  allActiveRuns: [runSummary],
  allClear: false,
  allClearDowntimeOverride: null,
  bumpPlatformVersion: noop,
  celebrationTrigger: 0,
  clusters: clustersResponse,
  dismissIntro: noop,
  greeting: {
    salutation: 'Good morning, Dana',
    subline: 'Two clusters account for most of this week’s failures.',
  },
  handleRecommendedAction: noop,
  healthScore: 78,
  heatmap: heatmapDays,
  heatmapCells,
  insightsOpen: false,
  ledger: recoveryLedger,
  longestOpen: { createdAt: '2026-08-26T02:00:30.000Z', durationMs: 79_170_000 },
  memoryPurgeCountdownLabel: null,
  metrics: recoveryMetrics,
  metricsError: null,
  metricsLoading: false,
  metricsStatus: 'available' as const,
  nowMs: NOW_MS,
  onOpenActivity: noop,
  onOpenMemoryGovernance: noop,
  onOpenRecoveryQueue: noop,
  onOpenRun: noop,
  onOpenTab: noop,
  onStartRecoveryDrill: noop,
  openDeadLetters: [deadLetter],
  openFailureCount: 12,
  operatorWins,
  recommendedActions: [
    {
      id: 'recover_cluster' as const,
      severity: 'danger' as const,
      title: 'Recover the billing 503 cluster',
      body: '31 failures share one signature. Applying the raised timeout clears them in a single campaign.',
      ctaLabel: 'Open recovery',
      ctaTab: 'recover' as const,
    },
    {
      id: 'resolve_approvals' as const,
      severity: 'warning' as const,
      title: 'Three approvals are waiting',
      body: 'Human-approval steps hold their runs open until someone answers.',
      ctaLabel: 'Review approvals',
      ctaTab: 'runs' as const,
    },
  ],
  recoveryClearEligible: false,
  setInsightsOpen: noop,
  showOnboarding: false,
  streak: { current: 4, longest: 11 },
  validation: validationReport,
  waitingNodes: [],
}

/** The ordinary morning: a backlog, ranked actions, health at 78. */
export function NeedsAttention() {
  return <RecoveryCenterView model={base} />
}

/** Nothing open and the all-clear earned — the state the screen aims for. */
export function AllClear() {
  return (
    <RecoveryCenterView
      model={{
        ...base,
        allClear: true,
        recoveryClearEligible: true,
        allClearDowntimeOverride: 1_284_000,
        healthScore: 97,
        openFailureCount: 0,
        openDeadLetters: [],
        activeRuns: [],
        allActiveRuns: [],
        longestOpen: null,
        recommendedActions: [],
        greeting: {
          salutation: 'Good morning, Dana',
          subline: 'Nothing is waiting on you.',
        },
      }}
    />
  )
}
