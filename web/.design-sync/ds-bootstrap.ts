/**
 * Preview bootstrap — loaded through `cfg.extraEntries`, so it runs once when
 * the design bundle is evaluated, before any preview renders.
 *
 * It does two things the app itself would otherwise do at boot:
 *
 * 1. Registers the English copy catalog. Without it the 257 `useT()` call sites
 *    render their dotted keys (`workflowRollout.loadFailed`) instead of prose.
 * 2. Replaces `fetch` with an offline router. Components that load on mount get
 *    a realistic payload; everything else gets `{}`.
 *
 * The router is NOT cosmetic. Several components destructure the response
 * without guarding — `FailureClustersCard` does `setData({ ...payload })` and
 * then reads `clusters.length`, so a blanket `{}` throws and the card renders
 * as an error boundary. Others (`ReplayCampaignsCard`, `SimilarRunsCard`) DO
 * guard, and for those the payload is what turns an honest-but-empty card into
 * one that shows the layout a designer needs to see.
 *
 * Shapes are read from the consuming component's own parser, not invented, and
 * they satisfy its validators (campaign `pacingMs` must be an integer in
 * [1000, 60000]; a semantic-search envelope needs `enabled: true`).
 */

import { useWorkflowStore } from '../src/store'
import en from '../src/i18n/locales/en/common.json'
import { registerRuntimeCatalog } from '../src/i18n/runtime'
import type { CatalogFragment } from '../src/i18n/resources'

registerRuntimeCatalog('en', en as CatalogFragment)

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

/** Frozen clock, matching `previews/_fixtures.ts` so relative times agree. */
const NOW_ISO = '2026-08-27T00:00:00.000Z'

/** `GET /workflows/schedule-preview` — validity follows the cron actually asked about. */
function schedulePreview(url: string): unknown {
  const cron = new URL(url, 'http://localhost').searchParams.get('cron') ?? ''
  const isFiveField = cron.trim().split(/\s+/).filter(Boolean).length === 5
  return isFiveField
    ? {
        valid: true,
        nextFires: [
          '2026-08-29T02:00:00.000Z',
          '2026-08-30T02:00:00.000Z',
          '2026-08-31T02:00:00.000Z',
        ],
      }
    : { valid: false, nextFires: [] }
}

/** `GET /dlq/clusters` — grouped failures, ordered by frequency. */
const dlqClusters = {
  totalSamples: 68,
  windowDays: 7,
  clusters: [
    {
      signature: 'HTTP 503 from billing.acme.com',
      category: 'http_error',
      frequency: 31,
      firstSeen: '2026-08-21T04:12:00.000Z',
      lastSeen: '2026-08-26T02:00:30.000Z',
      suggestedOwner: 'ops',
      affectedWorkflows: [
        { workflowId: 'wf_invoice_recon', workflowName: 'Invoice reconciliation', count: 24 },
        { workflowId: 'wf_dunning', workflowName: 'Dunning follow-up', count: 7 },
      ],
      samples: [
        { source: 'dead_letter', id: 'dlq_4f2a91', runId: 'run_9f21c4' },
        { source: 'failed_run_node', id: 'rn_71c803', runId: 'run_2ad118' },
      ],
    },
    {
      signature: 'Secret `stripe_restricted_key` is not configured',
      category: 'secret_missing',
      frequency: 19,
      firstSeen: '2026-08-23T11:40:00.000Z',
      lastSeen: '2026-08-25T18:22:10.000Z',
      suggestedOwner: 'workflow_author',
      affectedWorkflows: [
        { workflowId: 'wf_refund_audit', workflowName: 'Refund audit', count: 19 },
      ],
      samples: [{ source: 'dead_letter', id: 'dlq_9b30ce', runId: 'run_5c7712' }],
    },
    {
      signature: 'Request to api.openweather.example timed out after 30000ms',
      category: 'network_timeout',
      frequency: 12,
      firstSeen: '2026-08-20T07:05:00.000Z',
      lastSeen: '2026-08-26T21:44:00.000Z',
      suggestedOwner: 'platform',
      affectedWorkflows: [
        { workflowId: 'wf_route_planner', workflowName: 'Route planner', count: 12 },
      ],
      samples: [{ source: 'failed_run_node', id: 'rn_0ae642', runId: 'run_44b0f1' }],
    },
  ],
}

/** `GET /onboarding` — three milestones in, so the banner has a real next step. */
const onboarding = {
  enabled: true,
  status: 'active',
  currentStep: 'first_run_succeeded',
  completed: false,
  aiAvailable: true,
  skippedAt: null,
  completedAt: null,
  milestones: [
    { step: 'org_created', done: true, order: 0, target: 'settings' },
    { step: 'credential_configured', done: true, order: 1, target: 'credentials' },
    { step: 'pack_installed', done: true, order: 2, target: 'packs' },
    { step: 'first_run_succeeded', done: false, order: 3, target: 'runs' },
    { step: 'failure_injected', done: false, order: 4, target: 'runs' },
    { step: 'recovery_applied', done: false, order: 5, target: 'recovery' },
    { step: 'completed', done: false, order: 6, target: 'workflows' },
  ],
}

/** `GET /recovery/campaigns` — one campaign mid-flight, one finished. */
const recoveryCampaigns = {
  campaigns: [
    {
      id: 'rc_31a80f',
      name: 'Billing 503 backlog',
      pacingMs: 5_000,
      status: 'running',
      totalCount: 240,
      replayedCount: 148,
      failedCount: 6,
      cancelledCount: 0,
      createdAt: '2026-08-26T22:10:00.000Z',
      nextDispatchAt: '2026-08-27T00:00:05.000Z',
    },
    {
      id: 'rc_0f92cd',
      name: 'Refund audit — missing secret',
      pacingMs: 2_000,
      status: 'completed',
      totalCount: 19,
      replayedCount: 19,
      failedCount: 0,
      cancelledCount: 0,
      createdAt: '2026-08-25T19:02:00.000Z',
      nextDispatchAt: '2026-08-25T19:03:20.000Z',
    },
  ],
}

/** `GET /workflows/versions` — a bare array; index 1 becomes the rollout baseline. */
const workflowVersions = [
  { id: 'wfv_0007', version: 7 },
  { id: 'wfv_0006', version: 6 },
  { id: 'wfv_0005', version: 5 },
]

/** `GET /workflows/:id/rollout` — a canary that is winning but not yet promoted. */
const workflowRollout = {
  rollout: {
    id: 'rol_5db114',
    workflowId: 'wf_invoice_recon',
    baselineVersionId: 'wfv_0006',
    canaryVersionId: 'wfv_0007',
    trafficPercent: 25,
    minimumSampleSize: 40,
    minimumSuccessRatePercent: 95,
    status: 'active',
    baselineSucceeded: 182,
    baselineFailed: 11,
    canarySucceeded: 63,
    canaryFailed: 1,
    rolledBackReason: null,
    createdAt: '2026-08-25T08:00:00.000Z',
    updatedAt: NOW_ISO,
    endedAt: null,
    lastOutcomeAt: '2026-08-26T23:41:00.000Z',
  },
}

/**
 * `GET /workflows/:id/schedule-history` — a nightly 02:00 UTC cron. Cells are
 * generated so the heatmap has a readable diagonal rather than one hot square.
 */
function scheduleHistory(): unknown {
  const cells: Array<{
    dayOfWeek: number
    hour: number
    total: number
    success: number
    fail: number
    anomaly: boolean
  }> = []
  let totalFires = 0
  let totalSuccess = 0
  let totalFail = 0
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek += 1) {
    for (const hour of [2, 9, 14, 21]) {
      // Weekday mornings carry the load; Sunday 02:00 is the injected anomaly.
      const busy = hour === 9 && dayOfWeek > 0 && dayOfWeek < 6
      const total = busy ? 12 : hour === 2 ? 4 : 2
      const fail = dayOfWeek === 0 && hour === 2 ? 3 : busy ? 1 : 0
      cells.push({ dayOfWeek, hour, total, success: total - fail, fail, anomaly: fail >= 3 })
      totalFires += total
      totalSuccess += total - fail
      totalFail += fail
    }
  }
  return {
    workflowId: 'wf_invoice_recon',
    windowDays: 30,
    rowCap: 5000,
    capped: false,
    heatmap: { cells, totalFires, totalSuccess, totalFail, timezone: 'UTC' },
    schedules: [
      {
        nodeId: 'nightly_recon',
        cronExpression: '0 2 * * *',
        enabled: true,
        lastRunAt: '2026-08-26T02:00:00.000Z',
        lastRunId: 'run_9f21c4',
        nextFires: ['2026-08-27T02:00:00.000Z', '2026-08-28T02:00:00.000Z'],
      },
      {
        nodeId: 'weekday_sweep',
        cronExpression: '0 9 * * 1-5',
        enabled: false,
        lastRunAt: '2026-08-21T09:00:00.000Z',
        lastRunId: 'run_2ad118',
        nextFires: [],
      },
    ],
  }
}

/** `GET /runs/semantic-search` — the envelope needs `enabled: true` to be read. */
const semanticSearch = {
  enabled: true,
  entries: [
    {
      id: 'emb_7f10a2',
      runId: 'run_2ad118',
      similarity: 0.94,
      content: 'HTTP 503 from billing.acme.com after 30000ms — resolved by raising the step timeout to 90s.',
      metadata: { outcome: 'recovered' },
    },
    {
      id: 'emb_1c88b5',
      runId: 'run_5c7712',
      similarity: 0.81,
      content: 'Upstream returned 503 during the provider maintenance window; replay succeeded 40 minutes later.',
      metadata: { outcome: 'recovered' },
    },
    {
      id: 'emb_be2049',
      runId: 'run_44b0f1',
      similarity: 0.67,
      content: 'Gateway timeout on the same host; the run was accepted as a partial loss.',
      metadata: { outcome: 'accepted_loss' },
    },
  ],
}

/** `POST /workflows/readiness` — one blocking issue and one advisory. */
const readiness = {
  status: 'warn',
  issues: [
    {
      code: 'missing_retry_policy',
      severity: 'warn',
      message: 'Step "Fetch invoice" calls an external host with no retry policy.',
      suggestion: 'Add a retry with backoff so a single 5xx does not fail the run.',
      nodeId: 'fetch_invoice',
    },
    {
      code: 'unbounded_timeout',
      severity: 'warn',
      message: 'Step "Compare to PO" has no timeout, so a stalled provider holds the run open.',
      suggestion: 'Set a timeout at or below the workflow budget.',
      nodeId: 'compare',
    },
  ],
}

/**
 * `GET /snippets` — the built-ins the insert menu groups first, plus one org
 * snippet.
 *
 * `category` is required, not decoration: the menu builds an i18n key from it
 * (`snippets.category.<category>`), so a row without one renders the raw key.
 * `tags` is required too — the search filter calls `.join` on it.
 *
 * A built-in's `id` must be `builtin:<slug>` for a slug the copy catalog
 * actually carries (`snippets.builtin.<slug>.name`). An unknown slug renders
 * the raw dotted key in place of the snippet's name.
 */
const snippet = (
  id: string,
  name: string,
  description: string,
  category: 'approval' | 'error_handling' | 'notification' | 'transform' | 'custom',
  tags: string[],
  nodes: Array<{ id: string; type: string; label: string; config: Record<string, unknown> }>,
  builtin = true,
) => ({ id, name, description, category, tags, builtin, nodes, edges: [], entryNodeId: nodes[0]?.id })

const snippets = {
  snippets: [
    snippet(
      'builtin:http-with-circuit-breaker', 'Call an API', 'A GET with a timeout, a bounded response, and a breaker.',
      'transform', ['http', 'fetch'],
      [{ id: 'call', type: 'http', label: 'Call an API', config: { method: 'GET', timeoutMs: 30000 } }],
    ),
    snippet(
      'builtin:retry-with-backoff', 'Retry with backoff', 'Wrap a step so a single 5xx does not fail the run.',
      'error_handling', ['retry', 'resilience'],
      [{ id: 'retry', type: 'http', label: 'Call with retry', config: { retry: { maxAttempts: 3, backoff: 'exponential' } } }],
    ),
    snippet(
      'builtin:approval-with-timeout', 'Human approval', 'Hold the run until an operator approves the next step.',
      'approval', ['human', 'gate'],
      [{ id: 'approve', type: 'human_form', label: 'Approve', config: { onTimeout: 'escalate' } }],
    ),
    snippet(
      'builtin:slack-on-failure', 'Notify a channel', 'Post the run outcome to Slack.',
      'notification', ['slack', 'alert'],
      [{ id: 'notify', type: 'tool', label: 'Notify', config: { tool: 'slack.post' } }],
    ),
    snippet(
      'snp_acme_notify', 'Notify #billing', 'The billing team\u2019s own escalation format.',
      'custom', ['billing'],
      [{ id: 'billing_notify', type: 'tool', label: 'Notify #billing', config: { tool: 'slack.post', channel: '#billing' } }],
      false,
    ),
  ],
}

/** `GET /recovery/items/:id/children` — the occurrences behind a grouped incident. */
const recoveryChildren = {
  children: [
    { id: 'dlq_4f2a91', runId: 'run_9f21c4', createdAt: '2026-08-26T02:00:30.000Z', status: 'open' },
    { id: 'dlq_7c1e08', runId: 'run_2ad118', createdAt: '2026-08-25T02:00:28.000Z', status: 'replayed' },
    { id: 'dlq_2b9f44', runId: 'run_44b0f1', createdAt: '2026-08-24T02:00:31.000Z', status: 'replayed' },
  ],
}

/** `GET /workflows/health/delta` — health before vs after the applied fix. */
const healthDelta = {
  workflowId: 'wf_invoice_recon',
  afterVersion: 7,
  windowDays: 14,
  hasEnoughData: true,
  before: { score: 62, status: 'degraded', signals: { p95LatencyMs: 8_940, totalRuns: 212, totalCostUsd: 6.41 } },
  after: { score: 91, status: 'healthy', signals: { p95LatencyMs: 4_120, totalRuns: 188, totalCostUsd: 5.02 } },
  delta: { score: 29, p95LatencyMs: -4_820, costPerRunUsd: -0.0034 },
  recentRunsAgainstAfter: { totalRuns: 188, succeeded: 186, failed: 1, running: 1 },
  sameFailureSinceApply: null,
  priorVersion: { version: 6, versionId: 'wfv_0006' },
}

/**
 * `GET /workflows/:id/rollout/qualification` — the recovery gate on a canary.
 *
 * `required: true` is what makes the panel render at all; a workflow with no
 * recovery contract returns `false` and the panel hides itself. Every string
 * field here is required by the parser — a missing one silently degrades the
 * response to `qualification: null`.
 */
const rolloutQualification = {
  required: true,
  qualification: {
    id: 'rq_2f8014',
    status: 'passed',
    mode: 'compare',
    baselineVersionId: 'wfv_0006',
    candidateVersionId: 'wfv_0007',
    datasetVersion: '2026-08-19',
    datasetDigest: 'sha256:4c1f9a7e2b',
    createdAt: '2026-08-26T11:05:00.000Z',
    summary: {
      candidateAssertionCount: 24,
      passedCandidateAssertions: 24,
      failedCandidateAssertions: 0,
      regressionCount: 0,
      coverageFailureCount: 0,
      failures: [],
      failuresTruncated: false,
    },
  },
}

/** `GET /dlq?id=…` — the full dead-letter row behind a queue summary. */
const dlqDetail = {
  id: 'dlq_4f2a91',
  runId: 'run_9f21c4',
  nodeId: 'fetch_invoice',
  nodeType: 'http',
  workflowId: 'wf_invoice_recon',
  workflowName: 'Invoice reconciliation',
  attempt: 3,
  status: 'open',
  createdAt: '2026-08-26T02:00:30.000Z',
  errorJson: {
    message: 'HTTP 503 from billing.acme.com after 30000ms — upstream did not respond.',
    status: 503,
  },
  inputJson: { invoiceId: 'INV-20481' },
}

/**
 * `GET /workflows/health?workflowId=…` — the per-workflow health badge.
 *
 * Varied by workflow id rather than fixed: the workflows dashboard renders one
 * badge per row, and a constant score there would read as a rendering bug. The
 * `status` bands are the component's own — healthy ≥ 80, warn 60–79, unhealthy
 * below 60 — so the mapping here has to agree with the score it ships.
 */
const HEALTH_BY_WORKFLOW: Record<string, number> = {
  wf_invoice_recon: 74,
  wf_dunning: 91,
  wf_refund_audit: 58,
  wf_route_planner: 96,
  wf_onboard_vendor: 83,
}

function workflowHealth(url: string): unknown {
  const id = new URL(url, 'http://localhost').searchParams.get('workflowId') ?? ''
  const score = HEALTH_BY_WORKFLOW[id] ?? 87
  const status = score >= 80 ? 'healthy' : score >= 60 ? 'warn' : 'unhealthy'
  const entry = (value: number, rationale: string) => ({ score: value, rationale })
  return {
    score,
    status,
    breakdown: {
      reliability: entry(Math.max(0, score - 6), 'Terminal runs that succeeded in the window.'),
      safety: entry(Math.min(100, score + 8), 'Write-side steps carry an approval gate.'),
      cost: entry(Math.min(100, score + 4), 'Provider spend per run is within budget.'),
      latency: entry(Math.max(0, score - 12), 'The slowest 5% of runs cross the latency budget.'),
      maintainability: entry(score, 'Step count and branching stay inside the readable range.'),
      aiRisk: entry(Math.min(100, score + 2), 'No unbounded model output feeds a write step.'),
    },
    // The declared SLO travels with health rather than on its own endpoint:
    // `WorkflowSloPanel` reads `payload.slo.slo`, so `slo: null` leaves every
    // threshold field blank. Breach flags are kept consistent with the score —
    // the amber workflow is the one crossing its latency budget.
    slo: {
      slo: {
        successRatePercent: 95,
        mttrSeconds: 900,
        p95DurationMs: 4000,
        budgetBlocksPerWindow: 0,
        stuckWaitingNodesMax: 2,
        windowDays: 7 as const,
      },
      breaches: {
        successRatePercent: false,
        mttrSeconds: false,
        p95DurationMs: status !== 'healthy',
        budgetBlocksPerWindow: false,
        stuckWaitingNodesMax: false,
        anyBreach: status !== 'healthy',
      },
    },
  }
}

/**
 * `POST /credentials/:name/bulk-update` (dry run) — the rotation preview.
 *
 * `updatedAt` is the gate: the modal treats a missing one as a failed preview
 * and shows its generic error instead of the affected-workflow list, so the
 * field is not optional for a useful preview.
 */
function credentialRotatePreview(url: string): unknown {
  const name = decodeURIComponent((url.split('?')[0] ?? '').split('/credentials/')[1]?.split('/')[0] ?? 'credential')
  return {
    credentialName: name,
    kind: 'api_key',
    updatedAt: '2026-06-14T09:30:00.000Z',
    affectedCount: 3,
    affected: [
      { workflowId: 'wf_invoice_recon', workflowName: 'Invoice reconciliation', nodeIds: ['fetch_invoice'] },
      { workflowId: 'wf_dunning', workflowName: 'Dunning follow-up', nodeIds: ['charge_card', 'receipt'] },
      { workflowId: 'wf_refund_audit', workflowName: 'Refund audit', nodeIds: ['charge_card'] },
    ],
  }
}

/**
 * `GET /workflows/:id/metadata` — the ownership and coordination fields.
 *
 * The envelope must carry a `metadata` key: the parser rejects a payload
 * without one and the panel shows its load error, and `metadata: null` is the
 * legitimate "never set" case rather than a failure.
 */
const workflowMetadata = {
  metadata: {
    owners: ['dana@acme.com', 'sam@acme.com'],
    description: 'Reconciles nightly invoices against their purchase orders and escalates any mismatch to billing.',
    tags: ['billing', 'critical'],
    folder: 'Billing',
    slackChannel: '#alerts-prod',
    linearProject: 'acme/billing-ops',
    severityDefault: 'p2',
    runbookMarkdown: '## If this fails at 02:00\n\n1. Check the provider status page — 503s here are usually a maintenance window.\n2. If the window is open, wait it out; the paced replay campaign will drain the backlog.\n3. If not, raise the step timeout on a candidate version and qualify it before promoting.',
    aiGuidanceMarkdown: 'Prefer raising the step timeout over adding retries for this workflow: the upstream is slow at month end rather than flaky.',
  },
}

/**
 * `GET /org/config` — the tenant key/value settings.
 *
 * The AI-guidance panel looks for the `ai.operatorGuidance` entry specifically;
 * an envelope without it reads as a failed load, not as an empty setting.
 */
const orgConfig = {
  config: [
    {
      key: 'ai.operatorGuidance',
      value: 'Prefer raising a step timeout over adding retries when the upstream is slow rather than flaky. Never propose a patch that writes without an approval gate.',
    },
    { key: 'onboarding.enabled', value: 'true' },
  ],
}

/**
 * `POST /recovery/campaigns/preview` — which of the selected dead letters can
 * actually be replayed.
 *
 * This one needs the REQUEST BODY, not just the path: the dialog sends the ids
 * it wants and reads back the eligible/rejected split, so a fixed payload would
 * report a cohort the operator never selected. The last id is rejected on
 * purpose — a preview where everything passes hides the half of the dialog that
 * explains why something cannot be replayed.
 */
function campaignPreview(_url: string, body: unknown): unknown {
  const ids = Array.isArray((body as { deadLetterIds?: unknown })?.deadLetterIds)
    ? ((body as { deadLetterIds: unknown[] }).deadLetterIds.filter((id): id is string => typeof id === 'string'))
    : []
  const eligible = ids.slice(0, Math.max(0, ids.length - 1)).map((deadLetterId, index) => ({
    deadLetterId,
    runId: `run_${deadLetterId.slice(-6)}`,
    nodeId: index % 2 === 0 ? 'fetch_invoice' : 'charge_card',
  }))
  const rejected = ids.slice(Math.max(0, ids.length - 1)).map((deadLetterId) => ({
    deadLetterId,
    reason: 'already_replayed',
  }))
  return {
    canCreate: eligible.length > 0,
    clusterSignature: 'HTTP 503 from billing.acme.com',
    eligible,
    rejected,
  }
}

/**
 * `GET /runs` — the bounded run projection.
 *
 * The history-comparison dialog asks for the newest succeeded production run
 * before the selected one and treats an empty array as "no earlier successful
 * run", so this has to return a row for the diff path to be reachable.
 */
const priorRuns = [
  {
    id: 'run_02de55',
    workflowId: 'wf_invoice_recon',
    workflowName: 'Invoice reconciliation',
    workflowVersionId: 'wfv_0006',
    status: 'succeeded',
    createdAt: '2026-08-25T02:00:00.000Z',
    createdBy: 'scheduler',
  },
]

/** `GET /runs/compare` — the per-node diff between a baseline and a later run. */
const runComparison = {
  baseRun: {
    id: 'run_02de55',
    status: 'succeeded',
    replayMode: null,
    parentRunId: null,
    createdAt: '2026-08-25T02:00:00.000Z',
  },
  replayRun: {
    id: 'run_9f21c4',
    status: 'failed',
    replayMode: null,
    parentRunId: null,
    createdAt: '2026-08-26T02:00:00.000Z',
  },
  perNode: [
    {
      nodeId: 'fetch_invoice',
      base: {
        status: 'succeeded',
        latencyMs: 1_284,
        costUsd: null,
        tokens: 0,
        output: { invoiceId: 'INV-20480', totalUsd: 3980.1 },
        errorJson: null,
      },
      replay: {
        status: 'failed',
        latencyMs: 30_012,
        costUsd: null,
        tokens: 0,
        output: null,
        errorJson: { message: 'HTTP 503 from billing.acme.com after 30000ms', status: 503 },
      },
    },
    {
      nodeId: 'compare',
      base: {
        status: 'succeeded',
        latencyMs: 3_640,
        costUsd: 0.0174,
        tokens: 1_355,
        output: { match: true, deltaUsd: 0 },
        errorJson: null,
      },
      replay: { status: 'skipped', latencyMs: null, costUsd: null, tokens: 0, output: null, errorJson: null },
    },
    {
      nodeId: 'notify',
      base: {
        status: 'succeeded',
        latencyMs: 588,
        costUsd: null,
        tokens: 0,
        output: { channel: '#billing', ts: '1787702400.004' },
        errorJson: null,
      },
      replay: { status: 'skipped', latencyMs: null, costUsd: null, tokens: 0, output: null, errorJson: null },
    },
  ],
}

/**
 * Route table, matched in order. Each entry is `[predicate, payload]`; the
 * first match wins, and anything unmatched falls through to `{}` — which is
 * correct for the many endpoints that are only touched by a user action a
 * preview never performs.
 */
const ROUTES: Array<[(path: string) => boolean, (url: string, body: unknown) => unknown]> = [
  [(p) => p.includes('/workflows/schedule-preview'), schedulePreview],
  [(p) => p.includes('/workflows/readiness'), () => readiness],
  [(p) => p.includes('/workflows/versions'), () => workflowVersions],
  [(p) => p.endsWith('/rollout/qualification'), () => rolloutQualification],
  [(p) => p.endsWith('/rollout'), () => workflowRollout],
  [(p) => p.endsWith('/schedule-history'), scheduleHistory],
  [(p) => p.endsWith('/metadata'), () => workflowMetadata],
  [(p) => p.endsWith('/status-page'), () => ({ enabled: true, path: '/status/invoice-reconciliation' })],
  [(p) => p.includes('/workflows/health/delta'), () => healthDelta],
  [(p) => p.endsWith('/workflows/health'), workflowHealth],
  [(p) => p.includes('/dlq/clusters'), () => dlqClusters],
  [(p) => p === '/dlq' || p.endsWith('/dlq'), () => dlqDetail],
  [(p) => p.includes('/onboarding'), () => onboarding],
  [(p) => p.endsWith('/org/config'), () => orgConfig],
  [(p) => p.endsWith('/recovery/campaigns/preview'), campaignPreview],
  [(p) => p.includes('/recovery/campaigns'), () => recoveryCampaigns],
  [(p) => p.endsWith('/children'), () => recoveryChildren],
  [(p) => p.includes('/runs/semantic-search'), () => semanticSearch],
  [(p) => p.endsWith('/runs/compare'), () => runComparison],
  [(p) => p.endsWith('/runs'), () => priorRuns],
  [(p) => p.includes('/snippets'), () => snippets],
  [(p) => p.endsWith('/bulk-update'), credentialRotatePreview],
  [(p) => p.includes('/credentials'), () => []],
]

function stubFor(url: string, body: unknown): unknown {
  const path = url.split('?')[0] ?? url
  for (const [matches, build] of ROUTES) {
    if (matches(path)) return build(url, body)
  }
  return {}
}

/** Best-effort parse of a request body; a non-JSON body is simply `null`. */
function parseBody(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') return null
  try {
    return JSON.parse(init.body)
  } catch {
    return null
  }
}

if (typeof globalThis.fetch === 'function') {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    return json(stubFor(url, parseBody(init)))
  }) as typeof globalThis.fetch
}

/**
 * The app's zustand store, re-exported for preview authoring ONLY.
 *
 * A handful of components render nothing until the store holds something —
 * `ToastRenderer` needs a toast, `OnboardingBanner` needs an active onboarding
 * row, `WorkflowStatusPageCard` needs a selected workflow. Those states arrive
 * at runtime from the app shell, never from props, so a preview has no other
 * way to reach them.
 *
 * The double underscore is deliberate: this is harness surface, not part of the
 * design system. It is not a component and gets no card.
 *
 * **One store per card page.** Preview cells share this singleton, so two
 * stories on the same card cannot hold different store states — the last seed
 * wins and both cells render it. Store-gated components therefore ship a single
 * story; props-driven components keep their variants.
 */
export const __previewStore = useWorkflowStore

export const __janusly_i18n_ready = true
