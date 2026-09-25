type Row = Record<string, unknown>

/** A manifest-complete `/run` / `/status` run record from the fields a test cares about. */
export function runRecord(patch: Row & { id: string }): Row {
  return {
    orgId: 'org', status: 'running', createdAt: null, createdBy: null, inputJson: null, outputJson: null,
    outcomeStatus: null, parentLinkKind: null, parentNodeId: null, parentNotificationAfter: null, parentRunId: null,
    recoveryPlaybookAppliedRecordedAt: null, recoveryPlaybookValidationRecordedAt: null, replayMode: null,
    semanticViolationCount: 0, traceId: null, validationEvidenceLevel: null, workflowRolloutId: null,
    workflowRolloutVariant: null, workflowVersionId: 'version', ...patch,
  }
}

/** A manifest-complete `/run` / `/status` snapshot; nodes and events inherit the run id. */
export function runView(value: Row): Row {
  const run = runRecord((value.run ?? {}) as Row & { id: string })
  const runId = run.id
  return {
    eventsCursor: null,
    eventsHasMore: false,
    ...value,
    run,
    nodes: ((value.nodes ?? []) as Row[]).map(node => ({
      id: `row-${String(node.nodeId)}`, runId, status: 'pending', stateJson: null, errorJson: null,
      attempts: null, startedAt: null, finishedAt: null, ...node,
    })),
    events: ((value.events ?? []) as Row[]).map(event => ({
      runId, nodeId: null, payload: null, createdAt: null, holdUntil: null, ...event,
    })),
  }
}

/** Manifest-complete `GET /workflows/versions` rows from the fields a test cares about. */
export function versionRows(rows: Row[]): Row[] {
  return rows.map(row => ({
    orgId: 'org', createdAt: null, createdBy: null, sloJson: null, upstreamHealthSources: null, ...row,
  }))
}
