/**
 * Canonical closed enum of persistent-memory kinds — the SINGLE source of truth.
 *
 * This lives in its own leaf module (it imports nothing from the repos) so both
 * consumers can share it without an import cycle:
 * - `memoryEntriesRepo.ts` gates `commitMemory` writes + per-kind DEFAULT
 *   retention, and it imports `listOrgConfig` from `orgConfigRepo.ts`.
 * - `orgConfigRepo.ts` validates the `memory.allowedKinds` CSV +
 *   `memory.retentionDaysByKind` JSON against per-kind MAXIMUM retention.
 *
 * Because `memoryEntriesRepo` already depends on `orgConfigRepo`, the latter
 * cannot import from the former. A duplicated kind list can let write-time
 * support drift from config validation, making a new kind impossible to enable.
 * This leaf enum keeps the list defined once; each repo's
 * `Record<MemoryKind, number>` retention map still lives in its own layer
 * (write-time defaults vs. config-validation maxima are distinct concerns),
 * but TypeScript forces BOTH maps to cover every kind, so adding an entry here
 * fails the build until both layers are updated.
 *
 * Adding a kind: append it here, then satisfy the two retention maps
 * (`DEFAULT_RETENTION_DAYS` in `memoryEntriesRepo`, `MEMORY_RETENTION_MAX_DAYS`
 * in `orgConfigRepo`) the compiler flags, and update the memory-policy docs.
 */

/** Closed enum of memory kinds eligible for persistence. */
export const MEMORY_KINDS = [
  "recovery_rationale",
  "run_summary",
  "runbook_fragment",
  "patch_rationale",
  "generated_workflow",
  // Operator/tool-written vectors via the `vector.upsert` / `vector.search`
  // workflow tools — a dedicated namespace kept apart from the internal
  // recovery kinds above.
  "workflow_vector",
  // Cross-run episodic memory written + recalled by the `agent` / `multi_agent`
  // loop (goal + outcome of a completed agent run) so the planner can learn
  // from similar past episodes.
  "agent_episode",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Runtime guard for an untrusted string against the closed kind enum. */
export function isMemoryKind(value: string): value is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(value);
}
