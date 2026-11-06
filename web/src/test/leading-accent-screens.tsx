/**
 * Real components in every state that once carried a leading accent bar:
 * the no-leading-accent guard renders each one and inspects what it paints.
 * Data fetches go through `api`, which the caller mocks.
 */
import type { ReactElement } from 'react'
import { Activity, Coins, Gauge, ShieldCheck } from 'lucide-react'
import '../components/recovery-case/recovery-case.css'
import { AuthoringProblemsPanel } from '../components/AuthoringProblemsPanel'
import type { DeadLetter } from '../components/DeadLettersPanel'
import { ReasoningPanel } from '../components/ReasoningPanel'
import { RecentAlertsCard } from '../components/RecentAlertsCard'
import { RecoveryCaseDecision } from '../components/recovery-case/RecoveryCaseDecision'
import type { RecoveryCaseModel } from '../components/recovery-case/useRecoveryCaseController'
import { HomeActionWorkspace } from '../components/recovery-center/HomeActionWorkspace'
import type { RecommendedAction, RecommendedActionSeverity } from '../components/recovery-center/recovery-center-model'
import { RecoveryCenterTile } from '../components/recovery-center/RecoveryCenterTiles'
import { PlaybookMatchCard } from '../components/recovery-dialog/PlaybookMatchCard'
import { RecoveryPassportCard } from '../components/recovery-dialog/RecoveryPassportCard'
import { ReviewBody } from '../components/recovery-dialog/ReviewBody'
import type { PatchSuggestion, SuggestionTab } from '../components/recovery-dialog/types'
import { ValidationFailedBody } from '../components/recovery-dialog/ValidationFailedBody'
import { VitalSignsStrip, withSeverityLabels, type VitalSignsTileSeverity } from '../components/VitalSignsStrip'
import { useT } from '../i18n'
import type { WorkflowDefinition } from '../types'

const noop = () => {}

const before: WorkflowDefinition = {
  dslVersion: '1.0',
  nodes: [
    { id: 'fetch', type: 'http', config: { url: 'https://example.test' } },
    { id: 'notify', type: 'noop', config: {} },
  ],
  edges: [{ id: 'fetch-notify', from: 'fetch', to: 'notify' }],
} as WorkflowDefinition

const after: WorkflowDefinition = {
  dslVersion: '1.0',
  nodes: [
    { id: 'fetch', type: 'http', config: { url: 'https://example.test', retry: { maxAttempts: 3 } } },
    { id: 'audit', type: 'noop', config: {} },
  ],
  edges: [{ id: 'fetch-audit', from: 'fetch', to: 'audit' }],
} as WorkflowDefinition

const dlq: DeadLetter = {
  id: 'dlq-accent', runId: 'run-accent-0001', nodeId: 'fetch', attempt: 2, status: 'open',
  workflowJson: before, nodeJson: { id: 'fetch', type: 'http', config: {} }, errorJson: { message: 'ECONNRESET' },
  recovery: {
    id: 'ri-accent', owner: null, severity: 'p2', status: 'open',
    slaTargetAt: '2026-07-12T00:00:00.000Z', resolutionReason: null, comments: [], occurrenceCount: 3,
  },
}

const tab: SuggestionTab = {
  workflow: after,
  rationale: 'Retry the transient failure',
  approachLabel: 'add_retry',
  confidence: 82,
  safety: { writeSide: false, approvalRequired: false, approvalPresent: true },
  consideredAlternatives: [
    { approach: 'Raise the timeout', rejectedBecause: 'The failure is a reset, not a slow response.' },
    { approach: 'Skip the step', rejectedBecause: 'The notification depends on its output.' },
  ],
}

const playbookSuggestion: PatchSuggestion = {
  mode: 'playbook',
  suggestions: [tab],
  playbook: { id: 'pb-accent', version: 2, title: 'Recover billing dependency', successfulUses: 4, regressions: 0 },
}

const action = (severity: RecommendedActionSeverity, index: number): RecommendedAction => ({
  id: `action-${severity}`,
  kind: 'failure_cluster',
  priority: index + 1,
  title: `Recover ${index + 2} related failures`,
  body: 'A recurring failure signature has enough evidence for grouped triage.',
  ctaLabel: 'Open recovery queue',
  severity,
  target: { kind: 'dead_letter', id: `dlq-${severity}`, destination: 'runs' },
  allowedActions: ['dlq.inspect'],
} as RecommendedAction)

const tileSeverities = ['cobalt', 'cyan', 'success', 'warning', 'danger', 'neutral'] as const
const tileIcons = { cobalt: <Activity />, cyan: <Gauge />, success: <ShieldCheck />, warning: <Coins />, danger: <Coins />, neutral: <Gauge /> }
const vitalSeverities: VitalSignsTileSeverity[] = ['healthy', 'warn', 'unhealthy', 'neutral', 'info']

const recoveryCaseModel = {
  canResolve: true,
  recoveryCase: { id: 'case-accent' },
  latestDiagnosisPayload: {
    summary: 'The upstream returned a stale total.',
    mode: 'ai_enriched',
    hypotheses: [
      { id: 'h1', cause: 'Cached response served after the price change', confidence: 0.7, evidence: ['Cache hit on run'], counterEvidence: [] },
      { id: 'h2', cause: 'Detector threshold too tight', confidence: null, evidence: [], counterEvidence: ['Threshold unchanged for 30 days'] },
    ],
  },
  candidates: [
    {
      id: 'candidate-replace', kind: 'candidate',
      payload: {
        kind: 'replace_output', decision: 'replace', reason: 'Recompute the total from the order lines.', risk: 'low',
        evidence: [], expectedResult: 'Total matches the order lines', requiredPermissions: ['recovery.write'], output: { total: 42 },
      },
    },
    {
      id: 'candidate-accept', kind: 'candidate',
      payload: {
        kind: 'accept_loss', decision: 'accept_loss', reason: 'The order was refunded already.', risk: 'medium',
        evidence: [], expectedResult: 'Case closed without a change', requiredPermissions: ['recovery.write'],
      },
    },
  ],
  selectedCandidateId: 'candidate-replace',
  setSelectedCandidateId: noop,
} as unknown as RecoveryCaseModel

export const RECENT_ALERTS = {
  items: [
    { id: 'alert-delivered', policyName: 'Failure spike', trigger: 'run_failed', outcome: 'delivered', dispatchedAt: '2026-07-01T10:00:00.000Z', channelResults: [] },
    { id: 'alert-failed', policyName: 'Queue backlog', trigger: 'dlq_backlog', outcome: 'delivery_failed', dispatchedAt: '2026-07-01T09:00:00.000Z', channelResults: [] },
  ],
}

function VitalSigns() {
  const { t } = useT()
  return (
    <VitalSignsStrip
      tiles={withSeverityLabels(vitalSeverities.map((severity, index) => ({
        icon: <Activity size={14} />,
        label: `Metric ${index + 1}`,
        display: `${90 - index * 10}%`,
        severity,
        progressValue: 90 - index * 10,
        testId: `vital-${severity}`,
      })), t)}
    />
  )
}

export type AccentScreen = { name: string; ready: string; render: () => ReactElement }

export const ACCENT_SCREENS: AccentScreen[] = [
  {
    name: 'home-priority',
    ready: 'recovery-center-action-action-danger',
    render: () => (
      <HomeActionWorkspace
        actions={(['cobalt', 'warning', 'danger'] as const).map(action)}
        activeRuns={[]}
        activeRunCount={0}
        status="available"
        warnings={[]}
        onSelectAction={noop}
        onOpenRun={noop}
        onOpenActivity={noop}
      />
    ),
  },
  {
    name: 'vital-signs',
    ready: 'vital-unhealthy',
    render: () => <VitalSigns />,
  },
  {
    name: 'recovery-center-tiles',
    ready: 'tile-danger',
    render: () => (
      <div>
        {tileSeverities.map((severity) => (
          <RecoveryCenterTile key={severity} title={`Tile ${severity}`} kicker={severity} severity={severity} icon={tileIcons[severity]} testId={`tile-${severity}`}>
            <p>{severity}</p>
          </RecoveryCenterTile>
        ))}
      </div>
    ),
  },
  {
    name: 'recovery-review',
    ready: 'recovery-playbook-revalidation',
    render: () => (
      <ReviewBody
        suggestion={playbookSuggestion}
        selected={tab}
        selectedIndex={0}
        onSelectIndex={noop}
        dlq={dlq}
        canApplyPatch
        sandboxStatus="passed"
        failureSignature="Network reset on http node"
      />
    ),
  },
  {
    name: 'recovery-validation-failed',
    ready: 'recovery-playbook-regression',
    render: () => (
      <ValidationFailedBody
        suggestion={playbookSuggestion}
        selectedIndex={0}
        dlq={dlq}
        runId="run-validation-0001"
        errorJson={{ message: 'ECONNRESET' }}
        failureSignature="Network reset on http node"
        playbookRetired
      />
    ),
  },
  {
    name: 'recovery-passport',
    ready: 'recovery-confidence-passport',
    render: () => (
      <>
        <RecoveryPassportCard dlq={dlq} suggestion={{ mode: 'ai', suggestions: [], evidence: [{ kind: 'signature_rule', sourceRef: 'network_timeout', snippet: 'Matched timeout' }] }} selected={tab} actionable sandboxStatus="passed" failureSignature="Network reset on http node" />
        <RecoveryPassportCard dlq={dlq} suggestion={{ mode: 'fallback', suggestions: [] }} selected={{ ...tab, approachLabel: 'other', confidence: 0, safety: undefined }} actionable={false} sandboxStatus="not_run" failureSignature="Network reset on http node" />
      </>
    ),
  },
  {
    name: 'playbook-match',
    ready: 'recovery-playbook-match',
    render: () => (
      <PlaybookMatchCard
        playbook={{
          ...playbookSuggestion.playbook!, workflowId: 'wf-accent', signature: 'Network reset on http node', status: 'active',
          instructionsMarkdown: 'Retry with backoff.', approachLabel: 'add_retry', lastValidatedAt: null, activatedAt: null,
          retiredAt: null, createdAt: '2026-07-11T10:00:00.000Z', updatedAt: '2026-07-11T10:00:00.000Z',
        }}
        busy={null}
        onUse={noop}
        onRetire={noop}
      />
    ),
  },
  {
    name: 'authoring-problems',
    ready: 'authoring-problems',
    render: () => (
      <AuthoringProblemsPanel
        validationIssues={[{ code: 'condition_invalid_expression', message: 'Bad expression', nodeId: 'gate' }]}
        readiness={null}
        aiReviewIssues={[
          { code: 'missing_retry', message: 'No retry', nodeId: 'fetch', severity: 'warn', rationale: 'Flaky upstream', suggestion: 'Add retry' },
          { code: 'naming', message: 'Vague name', nodeId: 'notify', severity: 'info', rationale: 'Readability', suggestion: 'Rename' },
        ]}
        workflowEdges={[]}
        onValidate={async () => true}
      />
    ),
  },
  {
    name: 'recent-alerts',
    ready: 'recent-alert-row',
    render: () => <RecentAlertsCard />,
  },
  {
    name: 'run-events',
    ready: 'run-event-e-failed',
    render: () => (
      <div style={{ width: 720 }}>
        <ReasoningPanel
          activeRunId="run-accent"
          events={[
            { id: 'e-started', type: 'run.started', createdAt: '2026-07-14T12:00:00.000Z' },
            { id: 'e-waiting', type: 'node.waiting', nodeId: 'approve', createdAt: '2026-07-14T12:00:01.000Z' },
            { id: 'e-completed', type: 'node.completed', nodeId: 'fetch', createdAt: '2026-07-14T12:00:02.000Z' },
            { id: 'e-failed', type: 'node.failed', nodeId: 'notify', payload: { error: 'ECONNRESET' }, createdAt: '2026-07-14T12:00:03.000Z' },
          ]}
        />
      </div>
    ),
  },
  {
    name: 'recovery-case-decision',
    ready: 'recovery-diagnosis-case-accent',
    render: () => <RecoveryCaseDecision model={recoveryCaseModel} />,
  },
]
