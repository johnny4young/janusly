/**
 * DB-aware sidecars to the engine's pure `checkWorkflowReadiness` rule
 * set. The engine result is per-DAG (no I/O); the rollback-availability
 * check needs a `workflow_versions` lookup and lives here so the engine
 * package stays I/O-free.
 *
 * Used by `apps/api/src/routes/workflows-routes.ts` and
 * `apps/api/src/routes/runs-routes.ts` (the production-mode `/start`
 * gate).
 *
 * Invariants:
 * - Multi-tenant scope: the rollback query carries
 *   `eq(workflowVersions.orgId, orgId)`.
 * - Anonymous workflows (no `id`) skip the check — `workflow_versions`
 *   is keyed by the saved id, so an ad-hoc workflow has nothing to
 *   count.
 */

import { and, eq } from "drizzle-orm";

import { db, workflowVersions } from "@janusly/db";
import type { ReadinessIssue, ReadinessResult } from "@janusly/engine/src/workflow-readiness";
import type { Workflow } from "@janusly/shared";
import {
  listCredentialsForOrg,
  listConnections,
  readCredentialNameFromConfig,
  type SecretRefResolver,
} from "@janusly/data";

/**
 * Production resolver shared by the credential-health route and every
 * readiness call site that wires the credential sidecar. The data layer
 * NEVER reads ``process.env`` directly; this function is the single
 * chokepoint and is the only place that has to know how a missing /
 * blank env var is interpreted.
 */
export function productionSecretRefResolver(envVarName: string): boolean {
  const value = process.env[envVarName];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Layer the DB-aware rollback-availability check on top of the pure
 * `checkWorkflowReadiness` result. Workflows with only one persisted
 * version have no rollback target if a future save introduces a
 * regression; the readiness gate surfaces this as a `warn` so the
 * operator knows.
 */
export async function checkRollbackAvailability(orgId: string, workflowId: string | undefined): Promise<ReadinessIssue[]> {
  if (!workflowId) return [];
  const rows = await db
    .select({ id: workflowVersions.id })
    .from(workflowVersions)
    .where(and(eq(workflowVersions.orgId, orgId), eq(workflowVersions.workflowId, workflowId)));
  if (rows.length >= 2) return [];
  return [{
    code: "workflow_missing_rollback_version",
    severity: "warn",
    message: "Only one workflow version exists. If a future save introduces a regression there is no prior version to roll back to.",
    suggestion: "Save the workflow at least once more (or duplicate the current version) so the runtime improvement path can roll back if confidence drops.",
  }];
}

/**
 * Defensive cap on the number of distinct credential / MCP references
 * scanned per readiness call. Bounds the downstream DB round-trips
 * (`listCredentialsForOrg` is one bulk query; the actual hot path is
 * the Map lookups), NOT the node-iteration cost. A pathological
 * workflow with thousands of nodes that all reference the same handful
 * of credentials still iterates every node in JS but issues O(cap) DB
 * work, which is the intended posture.
 */
const READINESS_CREDENTIAL_REF_CAP = 50;

/**
 * Collect credential + MCP-alias references from a workflow's nodes
 * and emit a ``credential_missing`` warn issue for each one whose
 * secret material doesn't resolve in this environment.
 *
 * The check fires at the API layer (not the engine) because the lookup
 * crosses the engine/data boundary. The engine's pure-sync
 * ``checkWorkflowReadiness`` stays I/O-free; this sidecar layers the
 * extra issues on top via ``mergeReadiness``.
 *
 * Three load-bearing guarantees:
 * - The emitted message NEVER echoes the env-var name. Only the
 *   operator-chosen credential ``name`` or MCP ``alias`` appears in the
 *   user-visible text.
 * - When ``resolver`` is omitted the helper returns an empty array —
 *   call sites that haven't been wired yet stay byte-for-byte
 *   compatible with today's behaviour.
 * - Anonymous workflows (no saved ``id``) still get checked when the
 *   resolver is provided; the lookup is by credential name, not by
 *   workflow id.
 */
export async function getCredentialReadinessIssues(
  orgId: string,
  workflow: Workflow,
  resolver?: SecretRefResolver,
): Promise<ReadinessIssue[]> {
  if (!resolver) return [];

  // First pass: walk the DAG once and collect the distinct credential
  // names + MCP aliases each tagged with their node ids. We resolve
  // each unique reference once at most. The cap is checked AFTER each
  // potential write so a node carrying both a `credential` and a
  // `connectionAlias` can't sneak past the bound by 1 — strict
  // upper bound on Map keys = READINESS_CREDENTIAL_REF_CAP.
  const credentialRefs = new Map<string, string[]>(); // name → node ids
  const mcpAliasRefs = new Map<string, string[]>();
  const isCapped = () => credentialRefs.size + mcpAliasRefs.size >= READINESS_CREDENTIAL_REF_CAP;
  for (const node of workflow.nodes) {
    if (isCapped()) break;
    const credential = readCredentialNameFromConfig(node.config);
    if (credential) {
      if (credentialRefs.has(credential) || !isCapped()) {
        const nodes = credentialRefs.get(credential) ?? [];
        nodes.push(node.id);
        credentialRefs.set(credential, nodes);
      }
    }
    const alias = (node.config as { connectionAlias?: unknown }).connectionAlias;
    if (typeof alias === "string" && alias.length > 0) {
      if (mcpAliasRefs.has(alias) || !isCapped()) {
        const nodes = mcpAliasRefs.get(alias) ?? [];
        nodes.push(node.id);
        mcpAliasRefs.set(alias, nodes);
      }
    }
  }
  if (credentialRefs.size === 0 && mcpAliasRefs.size === 0) return [];

  // Bulk-load the org's credentials + MCP connections once, then index
  // by name / alias so each per-ref check is O(1).
  const [credentials, connections] = await Promise.all([
    credentialRefs.size > 0 ? listCredentialsForOrg(orgId) : Promise.resolve([]),
    mcpAliasRefs.size > 0 ? listConnections(orgId) : Promise.resolve([]),
  ]);
  const credentialBySecretRef = new Map<string, string>(); // name → secret_ref
  for (const row of credentials) credentialBySecretRef.set(row.name, row.secretRef);
  const connectionByAlias = new Map(connections.map((c) => [c.alias, c]));

  const issues: ReadinessIssue[] = [];

  for (const [name, nodeIds] of credentialRefs) {
    const secretRef = credentialBySecretRef.get(name);
    // The referenced credential row doesn't exist in this org at all.
    if (secretRef === undefined) {
      for (const nodeId of nodeIds) {
        issues.push({
          code: "credential_missing",
          severity: "warn",
          message: `Credential "${name}" is referenced by this workflow but no matching credential exists for this organization.`,
          nodeId,
          suggestion: "Register the credential in the admin UI before this workflow runs in production.",
        });
      }
      continue;
    }
    if (!resolver(secretRef)) {
      for (const nodeId of nodeIds) {
        issues.push({
          code: "credential_missing",
          severity: "warn",
          message: `Credential "${name}" has no resolvable secret in this environment.`,
          nodeId,
          suggestion: "Verify the operator has set the env var the credential maps to before the run starts.",
        });
      }
    }
  }

  for (const [alias, nodeIds] of mcpAliasRefs) {
    const connection = connectionByAlias.get(alias);
    if (!connection) {
      for (const nodeId of nodeIds) {
        issues.push({
          code: "credential_missing",
          severity: "warn",
          message: `MCP connection "${alias}" is referenced by this workflow but no matching connection exists for this organization.`,
          nodeId,
          suggestion: "Register the MCP connection in the admin UI before this workflow runs in production.",
        });
      }
      continue;
    }
    const missingKeys: string[] = [];
    for (const [key, ref] of Object.entries(connection.envRefs)) {
      if (!resolver(ref.name)) missingKeys.push(key);
    }
    if (missingKeys.length > 0) {
      for (const nodeId of nodeIds) {
        issues.push({
          code: "credential_missing",
          severity: "warn",
          message: `MCP connection "${alias}" has env references whose secrets don't resolve in this environment (${missingKeys.length} of ${Object.keys(connection.envRefs).length}).`,
          nodeId,
          suggestion: "Verify the env vars listed in the MCP connection settings are set before this workflow runs in production.",
        });
      }
    }
  }

  return issues;
}

/** Combine the pure readiness result with extra issues from DB-aware checks. Re-rolls up status to the worst severity across the union. */
export function mergeReadiness(base: ReadinessResult, extra: ReadinessIssue[]): ReadinessResult {
  const issues = [...base.issues, ...extra];
  const status = issues.some((issue) => issue.severity === "fail")
    ? "fail"
    : issues.some((issue) => issue.severity === "warn")
      ? "warn"
      : "pass";
  return { status, issues };
}
