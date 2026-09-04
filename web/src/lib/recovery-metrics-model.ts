/**
 * Read models for the two recovery telemetry reads that used to be cast
 * straight off the wire. Both components crashed on any payload that did not
 * match their expectation — a `{}` from an empty body, a stale proxy, or the
 * shape the OpenAPI manifest actually declared — and took their panel down
 * with them. These parsers narrow at the boundary and hand back a shape the
 * renderers can rely on, or `null` for "not a payload we understand".
 */

export type MetricSeverity = 'healthy' | 'warn' | 'unhealthy' | 'neutral'

export type RecoveryMetric = {
  value: number | null
  display: string
  severity: MetricSeverity
  rationale: string
  rationaleCode?: string
  rationaleMeta?: Record<string, string | number | boolean>
}

export type ClusterCategory =
  | 'secret_missing'
  | 'http_error'
  | 'network_timeout'
  | 'ai_provider'
  | 'parse_error'
  | 'tool_input'
  | 'unknown'

export type ClusterOwner = 'ops' | 'workflow_author' | 'platform'

export type ClusterWorkflow = { workflowId: string; workflowName: string; count: number }
export type ClusterSampleRef = { source: 'dead_letter' | 'failed_run_node'; id: string; runId: string }

export type FailureCluster = {
  signature: string
  category: ClusterCategory
  frequency: number
  affectedWorkflows: ClusterWorkflow[]
  firstSeen: string
  lastSeen: string
  suggestedOwner: ClusterOwner
  samples: ClusterSampleRef[]
}

export type FailureClusters = {
  clusters: FailureCluster[]
  totalSamples: number
  windowDays: number
}

const CLUSTER_CATEGORIES = new Set<ClusterCategory>([
  'secret_missing', 'http_error', 'network_timeout', 'ai_provider', 'parse_error', 'tool_input', 'unknown',
])
const CLUSTER_OWNERS = new Set<ClusterOwner>(['ops', 'workflow_author', 'platform'])
const SEVERITIES = new Set<MetricSeverity>(['healthy', 'warn', 'unhealthy', 'neutral'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function readClusterWorkflow(value: unknown): ClusterWorkflow | null {
  if (!isRecord(value) || typeof value.workflowId !== 'string') return null
  return {
    workflowId: value.workflowId,
    workflowName: readString(value.workflowName, value.workflowId),
    count: readCount(value.count),
  }
}

function readClusterSample(value: unknown): ClusterSampleRef | null {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.runId !== 'string') return null
  const source = value.source === 'failed_run_node' ? 'failed_run_node' : 'dead_letter'
  return { source, id: value.id, runId: value.runId }
}

function readCluster(value: unknown): FailureCluster | null {
  if (!isRecord(value) || typeof value.signature !== 'string') return null
  const category = CLUSTER_CATEGORIES.has(value.category as ClusterCategory) ? value.category as ClusterCategory : 'unknown'
  const owner = CLUSTER_OWNERS.has(value.suggestedOwner as ClusterOwner) ? value.suggestedOwner as ClusterOwner : 'ops'
  const workflows = Array.isArray(value.affectedWorkflows) ? value.affectedWorkflows : []
  const samples = Array.isArray(value.samples) ? value.samples : []
  return {
    signature: value.signature,
    category,
    frequency: readCount(value.frequency),
    affectedWorkflows: workflows.map(readClusterWorkflow).filter((row): row is ClusterWorkflow => row !== null),
    firstSeen: readString(value.firstSeen),
    lastSeen: readString(value.lastSeen),
    suggestedOwner: owner,
    samples: samples.map(readClusterSample).filter((row): row is ClusterSampleRef => row !== null),
  }
}

/**
 * `GET /dlq/clusters`. A payload without a `clusters` array is not a cluster
 * response — the card renders its error state rather than throwing on
 * `clusters.length`. Rows that fail their own shape are dropped, not fatal.
 */
export function parseFailureClusters(payload: unknown): FailureClusters | null {
  if (!isRecord(payload) || !Array.isArray(payload.clusters)) return null
  return {
    clusters: payload.clusters.map(readCluster).filter((row): row is FailureCluster => row !== null),
    totalSamples: readCount(payload.totalSamples),
    windowDays: readCount(payload.windowDays),
  }
}

/** A metric object the renderers can always read; absent or malformed input becomes a neutral placeholder. */
export function readRecoveryMetric(value: unknown): RecoveryMetric {
  if (!isRecord(value)) {
    return { value: null, display: '—', severity: 'neutral', rationale: '' }
  }
  const severity = SEVERITIES.has(value.severity as MetricSeverity) ? value.severity as MetricSeverity : 'neutral'
  const metric: RecoveryMetric = {
    value: typeof value.value === 'number' && Number.isFinite(value.value) ? value.value : null,
    display: readString(value.display, '—'),
    severity,
    rationale: readString(value.rationale),
  }
  if (typeof value.rationaleCode === 'string') metric.rationaleCode = value.rationaleCode
  if (isRecord(value.rationaleMeta)) {
    const meta: Record<string, string | number | boolean> = {}
    for (const [key, entry] of Object.entries(value.rationaleMeta)) {
      if (typeof entry === 'string' || typeof entry === 'number' || typeof entry === 'boolean') meta[key] = entry
    }
    metric.rationaleMeta = meta
  }
  return metric
}

export { isRecord as isRecoveryRecord }

export type CostProviderRow = {
  provider: string
  model: string
  usd: number
  tokens: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationInputTokens: number
  calls: number
  aggregated?: boolean
}

export type CacheEfficiency = {
  inputTokens: number
  readTokens: number
  creationTokens: number
  readSharePercent: number | null
}

export type RecoveryMetrics = {
  successRate: RecoveryMetric
  verifiedRecovery?: RecoveryMetric
  mttr: RecoveryMetric
  p95Latency: RecoveryMetric
  approvalsPending: RecoveryMetric
  replayRate: RecoveryMetric
  slaAttainment?: RecoveryMetric
  costThisWindow: RecoveryMetric & { providers: CostProviderRow[]; cache: CacheEfficiency }
  windowDays: number
  terminalRuns: number
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readProviderRow(value: unknown): CostProviderRow | null {
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.model !== 'string') return null
  const row: CostProviderRow = {
    provider: value.provider,
    model: value.model,
    usd: readNumber(value.usd),
    tokens: readNumber(value.tokens),
    inputTokens: readNumber(value.inputTokens),
    cachedInputTokens: readNumber(value.cachedInputTokens),
    cacheCreationInputTokens: readNumber(value.cacheCreationInputTokens),
    calls: readNumber(value.calls),
  }
  if (typeof value.aggregated === 'boolean') row.aggregated = value.aggregated
  return row
}

function readCache(value: unknown): CacheEfficiency {
  const cache = isRecord(value) ? value : {}
  return {
    inputTokens: readNumber(cache.inputTokens),
    readTokens: readNumber(cache.readTokens),
    creationTokens: readNumber(cache.creationTokens),
    readSharePercent: typeof cache.readSharePercent === 'number' && Number.isFinite(cache.readSharePercent)
      ? cache.readSharePercent
      : null,
  }
}

/**
 * `GET /recovery/metrics`. Anything that is an object becomes a fully
 * populated `RecoveryMetrics`: metrics the payload omits turn into neutral
 * placeholders, so the Operations page reads `costThisWindow.severity` and
 * `.providers` without a guard at every site. Non-objects are `null` and
 * render as the existing error state.
 */
export function parseRecoveryMetrics(payload: unknown): RecoveryMetrics | null {
  if (!isRecord(payload)) return null
  const cost = isRecord(payload.costThisWindow) ? payload.costThisWindow : {}
  const providers = Array.isArray(cost.providers) ? cost.providers : []
  const metrics: RecoveryMetrics = {
    successRate: readRecoveryMetric(payload.successRate),
    mttr: readRecoveryMetric(payload.mttr),
    p95Latency: readRecoveryMetric(payload.p95Latency),
    approvalsPending: readRecoveryMetric(payload.approvalsPending),
    replayRate: readRecoveryMetric(payload.replayRate),
    costThisWindow: {
      ...readRecoveryMetric(cost),
      providers: providers.map(readProviderRow).filter((row): row is CostProviderRow => row !== null),
      cache: readCache(cost.cache),
    },
    windowDays: readCount(payload.windowDays),
    terminalRuns: readCount(payload.terminalRuns),
  }
  if (isRecord(payload.verifiedRecovery)) metrics.verifiedRecovery = readRecoveryMetric(payload.verifiedRecovery)
  if (isRecord(payload.slaAttainment)) metrics.slaAttainment = readRecoveryMetric(payload.slaAttainment)
  return metrics
}
