type Row = Record<string, unknown>

const isRow = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value)
const fill = (defaults: Row, value: unknown) => value === undefined ? { ...defaults } : isRow(value) ? { ...defaults, ...value } : value
const METRIC: Row = { value: null, display: '—', severity: 'neutral', rationale: '', rationaleCode: 'ok' }
const metric = (value: unknown) => fill(METRIC, value)

/** A manifest-complete `RecoveryMetrics` from the fields a test cares about; a non-object passes through. */
export function recoveryMetrics(value: unknown): unknown {
  if (!isRow(value)) return value
  return {
    ...value,
    successRate: metric(value.successRate),
    mttr: metric(value.mttr),
    p95Latency: metric(value.p95Latency),
    approvalsPending: metric(value.approvalsPending),
    replayRate: metric(value.replayRate),
    recurrenceRate: metric(value.recurrenceRate),
    verifiedRecovery: fill({
      ...METRIC, definitionVersion: '1', metric: 'time_to_verified_recovery', unit: 'milliseconds',
      sampleSize: 0, p50Ms: null, p90Ms: null,
    }, value.verifiedRecovery),
    clustersResolved: fill({ ...METRIC, capped: false, totalEntries: 0 }, value.clustersResolved),
    costThisWindow: fill({
      ...METRIC, providers: [],
      cache: { creationTokens: 0, inputTokens: 0, readSharePercent: null, readTokens: 0 },
    }, value.costThisWindow),
    slaAttainment: fill({ ...METRIC, metSla: 0, resolvedInWindow: 0 }, value.slaAttainment),
    timeToFirstAction: fill({ ...METRIC, avgSeconds: null, p95Seconds: null, sampleSize: 0, unit: 'seconds' }, value.timeToFirstAction),
    costByProvider: value.costByProvider ?? [],
    downtimeEndedMs: value.downtimeEndedMs ?? 0,
    mttrMs: value.mttrMs ?? null,
    mttrTrend: value.mttrTrend ?? [],
    recurrence: fill({ recurred: 0, resolved: 0, stayedFixedRate: null, windowDays: 30 }, value.recurrence),
    valueEstimate: fill({
      assumptions: { baselineMttrSeconds: 0, hourlyCost: 0, minutesSavedPerRecovery: 0 },
      dollarSaved: 0, hoursSaved: 0, mttrDeltaSeconds: null,
    }, value.valueEstimate),
    terminalRuns: value.terminalRuns ?? 0,
    windowDays: value.windowDays ?? 30,
  }
}

const cluster = (value: unknown) => fill({
  signature: 'signature', category: 'unknown', frequency: 1, suggestedOwner: 'ops',
  firstSeen: '2026-07-27T12:00:00.000Z', lastSeen: '2026-07-27T12:00:00.000Z',
  recurredAfterRecovery: false, affectedWorkflows: [], samples: [],
}, value)

const deadLetterSummary = (value: unknown) => fill({
  id: 'dead-letter', orgId: 'org', runId: 'run', nodeId: 'node', nodeType: null, attempt: 1, status: 'open',
  errorJson: null, createdAt: null, replayedAt: null, workflowName: null, recovery: null,
}, value)

const SECTIONS: Partial<Record<string, (value: unknown) => unknown>> = {
  metrics: recoveryMetrics,
  clusters: value => isRow(value)
    ? { totalSamples: 0, windowDays: 30, ...value, clusters: Array.isArray(value.clusters) ? value.clusters.map(cluster) : value.clusters }
    : value,
  heatmap: value => isRow(value)
    ? {
        windowDays: 90,
        ...value,
        days: Array.isArray(value.days) ? value.days.map(day => fill({ failures: 0, recovered: 0, mttrSeconds: 0 }, day)) : value.days,
      }
    : value,
  validation: value => fill({ byRecoveryPath: [], samples: [] }, value),
  queue: value => isRow(value)
    ? {
        ...value,
        counts: fill({ total: 0, open: 0, replayed: 0, resolved: 0 }, value.counts),
        oldestOpen: value.oldestOpen == null ? null : deadLetterSummary(value.oldestOpen),
      }
    : value,
}

/** Completes each `ok` section of a test's `/recovery/home` envelope to its manifest shape. */
export function recoveryHome(value: Row): Row {
  if (!isRow(value.sections)) return value
  const sections = Object.fromEntries(Object.entries(value.sections).map(([key, section]) => {
    const complete = SECTIONS[key]
    return [key, complete && isRow(section) && section.status === 'ok' ? { ...section, value: complete(section.value) } : section]
  }))
  return { ...value, sections }
}
