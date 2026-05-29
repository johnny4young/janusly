/**
 * Public barrel for the `@janusly/data` package.
 *
 * Consumers (the API + engine/worker) import from `@janusly/data` rather
 * than reaching into `@janusly/data/src/<module>` — the `src` layout is
 * an implementation detail, and a file rename here must not break a
 * caller's import path.
 *
 * Two re-export shapes, both pointing at the same modules:
 *   - **Flat**: `export * from "./<module>"` — `import { getOrgConfigSnapshot } from "@janusly/data"`.
 *   - **Namespaced** (repos only): `export * as <name>Repo from "./<name>Repo"` —
 *     `import { orgConfigRepo } from "@janusly/data"; orgConfigRepo.getOrgConfigSnapshot(...)`.
 *     Handy for IDE discovery of "everything this repo exposes".
 *
 * Invariants:
 * - **No import cycle.** This barrel imports the repo modules; the repo
 *   modules import each other via RELATIVE sibling paths (`./xRepo`),
 *   never through this barrel. Keep it that way — routing an intra-`data`
 *   import through `@janusly/data` would create a cycle.
 * - **Eager load.** Importing `@janusly/data` pulls every repo module
 *   (and the shared drizzle client they share) into the graph. That's
 *   fine for the API/worker, which load most repos at boot anyway; no
 *   repo has a heavy import-time side effect beyond the shared client.
 * - **Data layer stays the only Drizzle consumer** — this barrel does
 *   not change that boundary; it only re-exports the existing surface.
 *
 * Getter naming convention for the re-exported repos lives in AGENTS.md
 * ("Repo naming"): get* / list* / find* / resolve* / query*.
 */

// ── Flat re-exports (every public module) ───────────────────────────────
export * from "./alert-dispatch";
export * from "./alertDispatchesRepo";
export * from "./alertPoliciesRepo";
export * from "./audit-tx";
export * from "./auditLogsRepo";
export * from "./autoHealingRepo";
export * from "./budgetRepo";
export * from "./credentialHealthRepo";
export * from "./credentialsRepo";
export * from "./failureClusterRepo";
export * from "./improvementsRepo";
export * from "./invitationsRepo";
export * from "./mcpConnectionsRepo";
export * from "./memoryConsent";
export * from "./memoryEntriesRepo";
export * from "./memoryUsage";
export * from "./orgConfigRepo";
export * from "./orgMembersRepo";
export * from "./orgRolesRepo";
export * from "./promptsRepo";
export * from "./rate-limit";
export * from "./rate-limit-degradation";
export * from "./recovery-item-creator";
export * from "./recovery-item-severity-default";
export * from "./recoveryFeedbackRepo";
export * from "./recoveryItemHandoffsRepo";
export * from "./recoveryItemsRepo";
export * from "./recoveryMetricsRepo";
export * from "./routingStatsRepo";
export * from "./runComparisonRepo";
export * from "./scheduleEntriesRepo";
export * from "./scimDirectoriesRepo";
export * from "./scimGroupStateRepo";
export * from "./scimProcessedEventsRepo";
export * from "./scimUserStateRepo";
export * from "./ssoConnectionsRepo";
export * from "./ssoStateNoncesRepo";
export * from "./usageRepo";
export * from "./verifiedDomainsRepo";
export * from "./workflowBudgetsRepo";
export * from "./workflowHealthRepo";
export * from "./workflowMetadataRepo";
export * from "./workflowRollbackRepo";
export * from "./workflowSloRepo";
export * from "./workflowsListRepo";

// ── Namespaced re-exports (repos only) — IDE-discoverable groupings ──────
export * as alertDispatchesRepo from "./alertDispatchesRepo";
export * as alertPoliciesRepo from "./alertPoliciesRepo";
export * as auditLogsRepo from "./auditLogsRepo";
export * as autoHealingRepo from "./autoHealingRepo";
export * as budgetRepo from "./budgetRepo";
export * as credentialHealthRepo from "./credentialHealthRepo";
export * as credentialsRepo from "./credentialsRepo";
export * as failureClusterRepo from "./failureClusterRepo";
export * as improvementsRepo from "./improvementsRepo";
export * as invitationsRepo from "./invitationsRepo";
export * as mcpConnectionsRepo from "./mcpConnectionsRepo";
export * as memoryEntriesRepo from "./memoryEntriesRepo";
export * as orgConfigRepo from "./orgConfigRepo";
export * as orgMembersRepo from "./orgMembersRepo";
export * as orgRolesRepo from "./orgRolesRepo";
export * as promptsRepo from "./promptsRepo";
export * as recoveryFeedbackRepo from "./recoveryFeedbackRepo";
export * as recoveryItemHandoffsRepo from "./recoveryItemHandoffsRepo";
export * as recoveryItemsRepo from "./recoveryItemsRepo";
export * as recoveryMetricsRepo from "./recoveryMetricsRepo";
export * as routingStatsRepo from "./routingStatsRepo";
export * as runComparisonRepo from "./runComparisonRepo";
export * as scheduleEntriesRepo from "./scheduleEntriesRepo";
export * as scimDirectoriesRepo from "./scimDirectoriesRepo";
export * as scimGroupStateRepo from "./scimGroupStateRepo";
export * as scimProcessedEventsRepo from "./scimProcessedEventsRepo";
export * as scimUserStateRepo from "./scimUserStateRepo";
export * as ssoConnectionsRepo from "./ssoConnectionsRepo";
export * as ssoStateNoncesRepo from "./ssoStateNoncesRepo";
export * as usageRepo from "./usageRepo";
export * as verifiedDomainsRepo from "./verifiedDomainsRepo";
export * as workflowBudgetsRepo from "./workflowBudgetsRepo";
export * as workflowHealthRepo from "./workflowHealthRepo";
export * as workflowMetadataRepo from "./workflowMetadataRepo";
export * as workflowRollbackRepo from "./workflowRollbackRepo";
export * as workflowSloRepo from "./workflowSloRepo";
export * as workflowsListRepo from "./workflowsListRepo";
