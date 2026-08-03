/**
 * Status constants and types — the single source of truth for `runs.status`
 * and `run_nodes.status` values across the API, engine, and web.
 *
 * This file has **zero runtime dependencies** so the web bundle can pull it
 * via `@/lib/status` without dragging in the workflow Zod
 * schemas (which live next door in `workflow.ts`). The browser bundle stays
 * Zod-free.
 *
 * Used by:
 * - The backend run and node persistence layer —
 *   wire-side comparisons, `inArray` clauses on cancellation paths, and
 *   terminal-status guards.
 * - `apps/api/src/routes/runs-routes.ts` — `/run/cancel`'s
 *   "already-terminal" guard.
 * - `apps/web/src/App.tsx`, `apps/web/src/components/RightPanel.tsx` —
 *   active-run polling shutdown and the Cancel button's disabled state.
 *
 * Invariants:
 * - The constant arrays match `runs.status` / `run_nodes.status` column
 *   values exactly. Adding a new status here without coordinating with
 *   persistence is a wire break.
 * - `cancelled` (double L) is the canonical spelling. The single-L spelling
 *   is a known historical typo and must never appear as a runtime status value
 *   or UI branch. The TypeScript types here are what enforce the spelling.
 * - Node-level vs run-level statuses are deliberately split. `skipped` is a
 *   node terminal status, never a run status. `created` is a run open
 *   status, never a node status. Don't merge the sets.
 */

/* -------- Node-level statuses (`run_nodes.status`) -------- */

/** Pre-terminal node statuses — the runtime is still scheduling work for them. */
export const nodeOpenStatusValues = ["pending", "queued", "running", "waiting"] as const;

/** Subset of open statuses the cancellation path flips to `cancelled` — `running` finishes naturally instead. */
export const nodeCancellableStatusValues = ["pending", "queued", "waiting"] as const;

/** Terminal node statuses — the runtime stops scheduling more work for these. */
export const nodeTerminalStatusValues = ["succeeded", "failed", "skipped", "cancelled"] as const;

/** Every node lifecycle status the column can hold. */
export const nodeStatusValues = [...nodeOpenStatusValues, ...nodeTerminalStatusValues] as const;

export type NodeOpenStatus = typeof nodeOpenStatusValues[number];
export type NodeCancellableStatus = typeof nodeCancellableStatusValues[number];
export type NodeTerminalStatus = typeof nodeTerminalStatusValues[number];
export type NodeStatus = typeof nodeStatusValues[number];

/* -------- Run-level statuses (`runs.status`) -------- */

/** Pre-terminal run statuses — the run is still progressing. */
export const runOpenStatusValues = ["created", "running", "waiting"] as const;

/** Terminal run statuses — once set, the runtime stops scheduling for the run. */
export const runTerminalStatusValues = ["succeeded", "failed", "cancelled", "timed_out"] as const;

/** Every run lifecycle status the column can hold. */
export const runStatusValues = [...runOpenStatusValues, ...runTerminalStatusValues] as const;

export type RunOpenStatus = typeof runOpenStatusValues[number];
export type RunTerminalStatus = typeof runTerminalStatusValues[number];
export type RunStatus = typeof runStatusValues[number];

/* -------- Set helpers for read-side membership checks -------- */

/** `Set` of node terminal statuses for `O(1)` `.has(...)` checks. */
export const TERMINAL_NODE_STATUSES: ReadonlySet<NodeTerminalStatus> = new Set(nodeTerminalStatusValues);

/** `Set` of run terminal statuses — used by web (Cancel button disabled state, polling shutdown) and API (`/run/cancel` 409 guard). */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunTerminalStatus> = new Set(runTerminalStatusValues);

/** `Set` of node open statuses — used by `updateRunStatusFromNodes` to detect "any work still pending." */
export const NODE_OPEN_STATUSES: ReadonlySet<NodeOpenStatus> = new Set(nodeOpenStatusValues);

/** `Set` of run open statuses — used by read-side activity and operational counters. */
export const RUN_OPEN_STATUSES: ReadonlySet<RunOpenStatus> = new Set(runOpenStatusValues);

/** Type guard for terminal node statuses received from persisted rows or API payloads. */
export function isTerminalNodeStatus(status: unknown): status is NodeTerminalStatus {
  return typeof status === "string" && TERMINAL_NODE_STATUSES.has(status as NodeTerminalStatus);
}

/** Type guard for terminal run statuses received from persisted rows or API payloads. */
export function isTerminalRunStatus(status: unknown): status is RunTerminalStatus {
  return typeof status === "string" && TERMINAL_RUN_STATUSES.has(status as RunTerminalStatus);
}

/** Type guard for open node statuses received from persisted rows or API payloads. */
export function isOpenNodeStatus(status: unknown): status is NodeOpenStatus {
  return typeof status === "string" && NODE_OPEN_STATUSES.has(status as NodeOpenStatus);
}

/** Type guard for open run statuses received from persisted rows or API payloads. */
export function isOpenRunStatus(status: unknown): status is RunOpenStatus {
  return typeof status === "string" && RUN_OPEN_STATUSES.has(status as RunOpenStatus);
}
