/**
 * Shared preview fixtures.
 *
 * NOT a component preview — the converter only treats `previews/<ComponentName>.tsx`
 * as an entry, and `buildPreviews` bundles with esbuild, so a relative import
 * from a preview pulls this in. The leading underscore keeps it obviously
 * out-of-band.
 *
 * Shapes are ported from the repo's own tests and type declarations rather
 * than invented. Where a value is illustrative (names, ids, amounts) it is
 * realistic operator-facing content, never `foo`/`test`.
 */

/** Fixed clock for anything that renders a relative or windowed time. */
export const NOW_MS = 1787788800000 // 2026-08-27T00:00:00Z
export const NOW_ISO = '2026-08-27T00:00:00.000Z'

/** Ported from `src/components/RecoveryDialog.test.tsx`. */
export const deadLetter = {
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
  // The workflow snapshot as it stood when the run failed. `ReviewBody` reads
  // it as the "before" side of the patch diff and crashes on `{}`, so a dead
  // letter fixture without it is not a valid fixture.
  get workflowJson() {
    return workflowDefinition
  },
}

/** A saved workflow definition, reused by the diff and rollback surfaces. */
export const workflowDefinition = {
  dslVersion: '1.0' as const,
  id: 'wf_invoice_recon',
  name: 'Invoice reconciliation',
  nodes: [
    {
      id: 'fetch_invoice',
      type: 'http',
      label: 'Fetch invoice',
      config: { url: 'https://api.acme.com/v1/invoices/{{ inputs.invoiceId }}', method: 'GET', timeoutMs: 30000 },
    },
    { id: 'compare', type: 'agent', label: 'Compare to PO', config: { model: 'claude-sonnet-5' } },
    { id: 'notify', type: 'tool', label: 'Notify billing', config: { tool: 'slack.post' } },
  ],
  edges: [
    { from: 'fetch_invoice', to: 'compare' },
    { from: 'compare', to: 'notify' },
  ],
}

/** `SourceRun` — the shape the replay-lab dialogs take. */
export const sourceRun = {
  id: 'run_9f21c4',
  status: 'failed',
  createdAt: '2026-08-26T02:00:00.000Z',
}

/** `RecoveryValidationReport` — a workspace that has been drilling regularly. */
export const validationReport = {
  generatedAt: NOW_ISO,
  windowDays: 30,
  sampleLimit: 500,
  sampleCapped: false,
  totals: {
    drills: 42,
    completed: 38,
    recovered: 31,
    acceptedLoss: 5,
    awaitingAction: 3,
    replayInProgress: 1,
    measurementIncomplete: 2,
    missingEvidence: 1,
    completionRatePercent: 90.5,
    recoveryRatePercent: 81.6,
  },
  resolution: {
    operator: 24,
    automated: 14,
    unknown: 0,
    operatorInterventionRatePercent: 63.2,
  },
  timing: {
    medianElapsedMs: 461_000,
    p90ElapsedMs: 1_240_000,
    averageElapsedMs: 604_000,
    p95ElapsedMs: 1_680_000,
    sampleSize: 38,
  },
  byFailureMode: [
    { key: 'upstream_timeout', total: 18, completed: 17, recovered: 16, acceptedLoss: 1, recoveryRatePercent: 94.1 },
    { key: 'credential_expired', total: 11, completed: 10, recovered: 8, acceptedLoss: 2, recoveryRatePercent: 80 },
    { key: 'schema_drift', total: 7, completed: 6, recovered: 4, acceptedLoss: 2, recoveryRatePercent: 66.7 },
    { key: 'rate_limited', total: 6, completed: 5, recovered: 3, acceptedLoss: 0, recoveryRatePercent: 60 },
  ],
}

/** `SessionContext` for an operator inside a usable organization. */
export const sessionContext = {
  identity: {
    userId: 'usr_2c90fa',
    email: 'dana@acme.com',
    mode: 'supabase' as const,
    source: 'web' as const,
  },
  profile: { name: 'Dana Okafor', email: 'dana@acme.com' },
  organizations: [
    {
      id: 'org_acme',
      name: 'Acme Operations',
      plan: 'team',
      role: 'editor',
      roleBase: 'editor' as const,
      permissions: ['workflows.read', 'runs.read', 'recovery.read', 'members.read'],
      usable: true,
      developmentFallback: false,
      isOwner: false,
    },
  ],
  invitations: [],
  currentOrganizationId: 'org_acme',
  selectionRequired: false,
  needsOrganization: false,
  truncated: false,
  invitationsTruncated: false,
}

/**
 * The same account with nothing to work in yet.
 *
 * `selectionRequired` must be `false` here: it is what switches the gate's copy
 * to "choose a workspace / your account belongs to more than one
 * organization", which contradicts an empty list.
 */
export const sessionNeedsOrganization = {
  ...sessionContext,
  organizations: [],
  currentOrganizationId: null,
  selectionRequired: false,
  needsOrganization: true,
}

/** An account in two organizations, with neither picked for this session. */
export const sessionSelectionRequired = {
  ...sessionContext,
  organizations: [
    sessionContext.organizations[0],
    {
      id: 'org_northwind',
      name: 'Northwind Logistics',
      plan: 'team',
      role: 'viewer',
      roleBase: 'viewer' as const,
      permissions: ['workflows.read', 'runs.read'],
      usable: true,
      developmentFallback: false,
      isOwner: false,
    },
  ],
  currentOrganizationId: null,
  selectionRequired: true,
  needsOrganization: false,
}

/** `RecoveryItemDrawerData` — an acknowledged incident with a comment trail. */
export const recoveryItem = {
  id: 'ri_8c31d0',
  deadLetterId: 'dlq_4f2a91',
  owner: 'dana@acme.com',
  severity: 'p2' as const,
  status: 'acknowledged' as const,
  slaTargetAtIso: '2026-08-29T09:30:00.000Z',
  resolutionReason: null,
  comments: [
    {
      id: 'c_01',
      authorUserId: 'dana@acme.com',
      body: 'Provider confirmed a maintenance window at 02:00 UTC. Holding replay until it closes.',
      createdAt: '2026-08-26T02:14:00.000Z',
    },
    {
      id: 'c_02',
      authorUserId: 'sam@acme.com',
      body: 'Raised the step timeout to 90s on the candidate version; sandbox validation passed.',
      createdAt: '2026-08-26T09:40:00.000Z',
    },
  ],
  workflowId: 'wf_invoice_recon',
  metadataWorkflowId: 'wf_invoice_recon',
}

/**
 * `RecoveryMetric` builder. `severity` is the metric's own verdict — the tiles
 * colour off it rather than re-deriving a threshold — and `rationale` is the
 * sentence shown under the number, so it must read like an explanation, not a
 * label.
 */
const metric = (
  value: number | null,
  display: string,
  severity: 'healthy' | 'warn' | 'unhealthy' | 'neutral',
  rationale: string,
) => ({ value, display, severity, rationale })

/** `RecoveryMetrics` for a workspace that is healthy but carrying a backlog. */
export const recoveryMetrics = {
  windowDays: 30,
  terminalRuns: 1284,
  successRate: metric(96.4, '96.4%', 'healthy', '1,238 of 1,284 terminal runs succeeded.'),
  mttr: metric(461_000, '7m 41s', 'healthy', 'Median time from failure to a recovered run.'),
  p95Latency: metric(4_120, '4.1s', 'warn', 'The slowest 5% of runs cross the 4s budget.'),
  approvalsPending: metric(3, '3', 'warn', 'Three human-approval steps are waiting on an operator.'),
  replayRate: metric(8.2, '8.2%', 'healthy', '105 of 1,284 runs needed a replay.'),
  slaAttainment: metric(99.1, '99.1%', 'healthy', 'Incidents resolved inside their severity target.'),
  costThisWindow: metric(41.87, '$41.87', 'neutral', 'Provider spend across the 30-day window.'),
  // Optional metrics. Older API responses omit them and the tiles fall back to
  // an em dash, so a fixture that leaves them out renders a half-empty card.
  timeToFirstAction: metric(184_000, '3m 4s', 'healthy', 'Median time before an operator picks up a new incident.'),
  recurrenceRate: metric(4.8, '4.8%', 'healthy', 'Recovered failures whose signature returned within seven days.'),
  clustersResolved: {
    ...metric(7, '7 of 9', 'healthy', 'Failure clusters closed out inside the window.'),
    totalEntries: 9,
    capped: false,
  },
  valueEstimate: {
    hoursSaved: 41.5,
    dollarSaved: 3_112,
    mttrDeltaSeconds: -604,
    assumptions: { hourlyCost: 75, minutesSavedPerRecovery: 8, baselineMttrSeconds: 1_065 },
  },
  mttrTrend: [
    { day: '2026-08-21', seconds: 512 },
    { day: '2026-08-22', seconds: 1_810 },
    { day: '2026-08-23', seconds: 300 },
    { day: '2026-08-24', seconds: 640 },
    { day: '2026-08-25', seconds: 402 },
    { day: '2026-08-26', seconds: 1_240 },
    { day: '2026-08-27', seconds: 455 },
  ],
}

/** `RunSummary` for a run that failed at the HTTP step. */
export const runSummary = {
  id: 'run_9f21c4',
  workflowId: 'wf_invoice_recon',
  workflowName: 'Invoice reconciliation',
  workflowVersionId: 'wfv_0007',
  status: 'failed',
  outcomeStatus: null,
  hasWaitingNodes: false,
  createdBy: 'dana@acme.com',
  createdAt: '2026-08-26T02:00:00.000Z',
  // The full run-start envelope. `RunObservationWorkspace` projects its
  // companion canvas from `inputJson.workflow` — without the snapshot there is
  // no graph to draw and the canvas half renders empty.
  get inputJson() {
    return { workflow: workflowDefinition, inputs: { invoiceId: 'INV-20481' } }
  },
}

/** The same run's node rows: two done, one failed after three attempts. */
export const runNodes = [
  {
    nodeId: 'fetch_invoice',
    status: 'failed',
    attempts: 3,
    startedAt: '2026-08-26T02:00:00.000Z',
    finishedAt: '2026-08-26T02:00:30.000Z',
    errorJson: {
      message: 'HTTP 503 from billing.acme.com after 30000ms — upstream did not respond.',
      status: 503,
    },
  },
  {
    nodeId: 'compare',
    status: 'skipped',
    attempts: 0,
    startedAt: null,
    finishedAt: null,
  },
  {
    nodeId: 'notify',
    status: 'skipped',
    attempts: 0,
    startedAt: null,
    finishedAt: null,
  },
]

/** `VersionForRollback` pair — version 7 is live, version 6 is the target. */
export const currentVersion = {
  id: 'wfv_0007',
  version: 7,
  dagJson: workflowDefinition,
}

export const targetVersion = {
  id: 'wfv_0006',
  version: 6,
  dagJson: {
    ...workflowDefinition,
    nodes: workflowDefinition.nodes.map((node) =>
      node.id === 'fetch_invoice'
        ? { ...node, config: { ...node.config, timeoutMs: 10000 } }
        : node,
    ),
  },
}

/** `PreSaveBeforeSnapshot` — health as it stood the moment the fix was saved. */
export const preSaveBeforeSnapshot = {
  score: 62,
  status: 'degraded',
  signals: { p95LatencyMs: 8_940, totalRuns: 212, totalCostUsd: 6.41 },
}

/**
 * `PatchSuggestion` — what the recovery pipeline proposes for the invoice 503.
 *
 * The route guarantees `suggestions` has at least one entry and sorts it by
 * confidence descending; `suggestedWorkflow` and `rationale` are legacy mirrors
 * of `suggestions[0]` and must stay in step with it.
 *
 * `calibratedConfidence` is the number an operator should trust — the model's
 * raw self-rating mapped through the org's per-approach curve. It sits below
 * the raw score here because this org has seen `add_retry` over-promise.
 */
const raisedTimeout = {
  ...workflowDefinition,
  nodes: workflowDefinition.nodes.map((node) =>
    node.id === 'fetch_invoice'
      ? { ...node, config: { ...node.config, timeoutMs: 90000 } }
      : node,
  ),
}

const withRetry = {
  ...workflowDefinition,
  nodes: workflowDefinition.nodes.map((node) =>
    node.id === 'fetch_invoice'
      ? { ...node, config: { ...node.config, retry: { maxAttempts: 3, backoff: 'exponential' } } }
      : node,
  ),
}

export const patchSuggestion = {
  mode: 'ai' as const,
  suggestedWorkflow: raisedTimeout,
  rationale:
    'The upstream answered every attempt with 503 after the full 30s budget, so the step is timing out before the provider responds rather than failing outright.',
  suggestions: [
    {
      workflow: raisedTimeout,
      approachLabel: 'raise_timeout' as const,
      rationale:
        'The upstream answered every attempt with 503 after the full 30s budget, so the step is timing out before the provider responds rather than failing outright.',
      confidence: 88,
      calibratedConfidence: 81,
      safety: { writeSide: false, approvalRequired: false, approvalPresent: false },
      consideredAlternatives: [
        {
          approach: 'Swap the credential reference',
          rejectedBecause: 'The response was 503, not 401 — the credential resolved correctly.',
        },
      ],
    },
    {
      workflow: withRetry,
      approachLabel: 'add_retry' as const,
      rationale:
        'Retrying with exponential backoff rides out a short maintenance window without changing the request budget.',
      confidence: 74,
      calibratedConfidence: 59,
      safety: { writeSide: false, approvalRequired: false, approvalPresent: false },
      consideredAlternatives: [
        {
          approach: 'Raise the step timeout',
          rejectedBecause: 'A longer timeout holds the run open even when the provider is down.',
        },
      ],
    },
  ],
  // `EvidenceRow`, not a free-form summary: every row needs `kind`, `snippet`
  // and `sourceRef`. `EvidencePanel` re-scrubs each one and drops any whose
  // snippet is empty, so a row shaped wrong disappears rather than erroring.
  evidence: [
    {
      kind: 'recent_error' as const,
      sourceRef: 'run_2ad118',
      label: 'Recent similar error',
      snippet: 'HTTP 503 from billing.acme.com after 30000ms — recovered once the step timeout was raised to 90s.',
    },
    {
      kind: 'recovery_feedback' as const,
      sourceRef: 'fb_9a02c1',
      label: 'Accepted 4 days ago',
      snippet: 'The last accepted fix for this workflow raised the invoice-fetch timeout; the operator noted the provider is slow at month end.',
    },
    {
      kind: 'signature_rule' as const,
      sourceRef: 'sig_http_5xx_timeout',
      snippet: 'Signature rule "http 5xx after full budget" matched, which routes to timeout and retry approaches.',
    },
  ],
}

/**
 * Canvas graph fixtures shared by the authoring surfaces.
 *
 * `WorkflowGraphNode` is a React Flow `Node`, but only its data is read here —
 * these are plain objects, and no `ReactFlowProvider` is involved. (Components
 * that actually render inside the canvas cannot be previewed at all; see
 * NOTES.md.)
 */
export const graphNodes = [
  {
    id: 'fetch_invoice',
    type: 'workflowStep',
    position: { x: 0, y: 0 },
    data: {
      label: 'Fetch invoice',
      type: 'http',
      config: { url: 'https://api.acme.com/v1/invoices/{{ inputs.invoiceId }}', method: 'GET', timeoutMs: 30000 },
      status: 'failed',
      hasValidationError: false,
    },
  },
  {
    id: 'compare',
    type: 'workflowStep',
    position: { x: 240, y: 0 },
    data: { label: 'Compare to PO', type: 'agent', config: { model: 'claude-sonnet-5' }, status: 'skipped' },
  },
  {
    id: 'notify',
    type: 'workflowStep',
    position: { x: 480, y: 0 },
    data: { label: 'Notify billing', type: 'tool', config: { tool: 'slack.post' }, status: 'skipped' },
  },
]

/**
 * `type` must name a REGISTERED React Flow type or the canvas silently falls
 * back to the library default: `workflowStep` for nodes, `workflowEdge` for
 * edges. An edge without it still draws a line, but it is not Janusly's edge
 * component and shows no condition or on-error label.
 *
 * Edge `condition` strings are evaluated by a deliberately small grammar:
 * boolean composition, comparisons, a few string/collection operators, literals,
 * and dotted paths that MUST start with `context.` or `inputs.`. A bare word
 * like `mismatch` is rejected as unsupported, and the inspector says so — so a
 * fixture has to use the real grammar or the preview shows a validation error.
 */
export const graphEdges = [
  { id: 'e1', type: 'workflowEdge', source: 'fetch_invoice', target: 'compare', data: {} },
  {
    id: 'e2',
    type: 'workflowEdge',
    source: 'compare',
    target: 'notify',
    data: { condition: 'context.compare.output.match === false', hasCondition: true },
  },
]

/** The tool catalog the inspector offers for a `tool` step. */
export const tools = [
  {
    name: 'slack.post',
    description: 'Post a message to a Slack channel.',
    required: ['channel', 'text'],
    inputFields: [],
  },
  {
    name: 'sheets.append',
    description: 'Append a row to a Google Sheet.',
    required: ['spreadsheetId', 'values'],
    inputFields: [],
  },
]

/** Saved workflows, for the pickers that offer a sub-workflow call. */
export const savedWorkflows = [
  { id: 'wf_invoice_recon', orgId: 'org_acme', name: 'Invoice reconciliation', lastRunStatus: 'failed', runCount: 1284 },
  { id: 'wf_dunning', orgId: 'org_acme', name: 'Dunning follow-up', lastRunStatus: 'succeeded', runCount: 412 },
]

/** `RunComparisonPayload` — the original run against its replay. */
export const runComparison = {
  baseRun: {
    id: 'run_9f21c4',
    status: 'failed',
    replayMode: null,
    parentRunId: null,
    createdAt: '2026-08-26T02:00:00.000Z',
  },
  replayRun: {
    id: 'run_c40e77',
    status: 'succeeded',
    replayMode: 'from_failed_step',
    parentRunId: 'run_9f21c4',
    createdAt: '2026-08-26T10:15:00.000Z',
  },
  perNode: [
    {
      nodeId: 'fetch_invoice',
      base: {
        status: 'failed',
        latencyMs: 30_012,
        costUsd: null,
        tokens: 0,
        output: null,
        errorJson: { message: 'HTTP 503 from billing.acme.com after 30000ms', status: 503 },
      },
      replay: {
        status: 'succeeded',
        latencyMs: 1_284,
        costUsd: null,
        tokens: 0,
        output: { invoiceId: 'INV-20481', totalUsd: 4210.55 },
        errorJson: null,
      },
    },
    {
      nodeId: 'compare',
      base: { status: 'skipped', latencyMs: null, costUsd: null, tokens: 0, output: null, errorJson: null },
      replay: {
        status: 'succeeded',
        latencyMs: 3_902,
        costUsd: 0.0186,
        tokens: 1_412,
        output: { match: false, deltaUsd: 118.4 },
        errorJson: null,
      },
    },
    {
      nodeId: 'notify',
      base: { status: 'skipped', latencyMs: null, costUsd: null, tokens: 0, output: null, errorJson: null },
      replay: {
        status: 'succeeded',
        latencyMs: 612,
        costUsd: null,
        tokens: 0,
        output: { channel: '#billing', ts: '1787816100.001' },
        errorJson: null,
      },
    },
  ],
}

/**
 * Recovery-center heatmap fixtures — 14 days, oldest first.
 *
 * `HeatmapCell.outcome` is derived, not free: `recovered` when every failure
 * that day was recovered, `partial` when some were, `unrecovered` when none
 * were, `none` when the day was clean. The fixture follows that rule so the
 * colour bands read correctly.
 */
const heatmapSource: Array<[string, number, number, number]> = [
  ['2026-08-14', 0, 0, 0],
  ['2026-08-15', 2, 2, 380],
  ['2026-08-16', 0, 0, 0],
  ['2026-08-17', 1, 1, 210],
  ['2026-08-18', 5, 3, 940],
  ['2026-08-19', 3, 3, 455],
  ['2026-08-20', 0, 0, 0],
  ['2026-08-21', 4, 4, 512],
  ['2026-08-22', 7, 2, 1810],
  ['2026-08-23', 2, 2, 300],
  ['2026-08-24', 1, 0, 0],
  ['2026-08-25', 6, 6, 402],
  ['2026-08-26', 9, 5, 1240],
  ['2026-08-27', 0, 0, 0],
]

export const heatmapDays = heatmapSource.map(([day, failures, recovered, mttrSeconds]) => ({
  day,
  failures,
  recovered,
  mttrSeconds,
}))

export const heatmapCells = heatmapSource.map(([day, failures, recovered]) => ({
  day,
  failures,
  recovered,
  outcome:
    failures <= 0 ? ('none' as const)
    : recovered >= failures ? ('recovered' as const)
    : recovered > 0 ? ('partial' as const)
    : ('unrecovered' as const),
}))

/** `ClustersResponse` — the same grouping the failure-clusters card shows. */
export const clustersResponse = {
  totalSamples: 68,
  windowDays: 7,
  clusters: [
    {
      signature: 'HTTP 503 from billing.acme.com',
      category: 'http_error' as const,
      frequency: 31,
      firstSeen: '2026-08-21T04:12:00.000Z',
      lastSeen: '2026-08-26T02:00:30.000Z',
      suggestedOwner: 'ops' as const,
      affectedWorkflows: [
        { workflowId: 'wf_invoice_recon', workflowName: 'Invoice reconciliation', count: 24 },
        { workflowId: 'wf_dunning', workflowName: 'Dunning follow-up', count: 7 },
      ],
      samples: [{ source: 'dead_letter' as const, id: 'dlq_4f2a91', runId: 'run_9f21c4' }],
    },
    {
      signature: 'Secret `stripe_restricted_key` is not configured',
      category: 'secret_missing' as const,
      frequency: 19,
      firstSeen: '2026-08-23T11:40:00.000Z',
      lastSeen: '2026-08-25T18:22:10.000Z',
      suggestedOwner: 'workflow_author' as const,
      affectedWorkflows: [{ workflowId: 'wf_refund_audit', workflowName: 'Refund audit', count: 19 }],
      samples: [{ source: 'dead_letter' as const, id: 'dlq_9b30ce', runId: 'run_5c7712' }],
    },
  ],
}

/** `RecoveryLedger` — the running total the hero counts up from. */
export const recoveryLedger = {
  totalRecovered: 318,
  downtimeEndedMs: 1_284_000,
  sinceIso: '2026-02-01T00:00:00.000Z',
}

/** `OperatorWins` — this operator's own share of the window. */
export const operatorWins = { recovered: 27, windowDays: 30 }
