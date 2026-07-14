/**
 * Zero-dependency path catalog for reads that the first-party web client sends
 * through the stable `/v1` API lane.
 *
 * Used by `apps/api/src/api-contracts.ts` and `apps/web/src/api.ts`. Keeping the
 * values here prevents the browser transport map from drifting from OpenAPI.
 */

export const V1_READ_PATHS = {
  recoveryMetrics: "/recovery/metrics",
  recoveryLedger: "/recovery/ledger",
  recoveryMyWins: "/recovery/my-wins",
  workflows: "/workflows",
  workflowVersions: "/workflows/versions",
  latestWorkflowVersion: "/workflows/latest",
  runs: "/runs",
  run: "/run",
  runStatus: "/status",
} as const;

export type V1ReadPath = typeof V1_READ_PATHS[keyof typeof V1_READ_PATHS];

const V1_READ_PATH_SET: ReadonlySet<string> = new Set(Object.values(V1_READ_PATHS));

/** True when an exact URL pathname belongs to the stable v1 read lane. */
export function isV1ReadPath(pathname: string): pathname is V1ReadPath {
  return V1_READ_PATH_SET.has(pathname);
}
