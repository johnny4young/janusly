/**
 * Typed audit-write helper for authenticated API routes.
 *
 * Wraps the lower-level `audit()` chokepoint in `./audit.ts` with two
 * compile-time guarantees the bare 6-positional-arg function can't give:
 *
 *   1. `action` is typed against the closed `AuditAction` catalog below,
 *      so a typo'd or unknown action name is a TypeScript error at the
 *      call site (mirrors the `ApiErrorCode` closed-union precedent in
 *      `./error-codes.ts`).
 *   2. The forensic `actor` + `source` block is derived once, here, from
 *      the request's `AuthContext` — so no route hand-builds it and every
 *      route audit row carries a consistent actor/source shape (this
 *      supersedes the old per-route `mcpAuditMetadata(auth)` spread).
 *
 * The caller passes `targetType` / `targetId` / `metadata` through a
 * named options object; the helper merges the derived `actor`/`source`
 * on top of the caller's metadata (helper keys win on collision so the
 * normalized block is authoritative) and forwards to `audit()`, which
 * still owns secret redaction + size bounding + never-throw behavior.
 *
 * SCOPE: this helper is for route handlers that have an `AuthContext` in
 * scope. System-actor writers that run outside a request
 * (`scim-event-handler`, `auto-healing-watcher`, `budget-gate`, the
 * membership resolver in `auth.ts`/`auth-policy.ts`) and the skipAuth
 * route handlers (the SSO callback, the SCIM webhook receiver) build
 * their audit rows from resolved state with synthetic actors
 * (`"system:..."`, `"scim:webhook"`) and stay on the lower-level
 * `audit()`. The transaction-bound `withAuditTx` audit (e.g. the SSO
 * login row) is a separate atomic chokepoint and is also unaffected.
 *
 * Used by every authenticated mutating route under `apps/api/src/routes/*`.
 *
 * Adding a new route audit action is two edits: add the action name to
 * the `AuditAction` union below, then call
 * `auditAction(auth, "<action>", { targetType, targetId, metadata })`.
 */

import { audit } from "./audit";
import type { AuthContext } from "./auth";

/**
 * Closed catalog of audit action names emitted from authenticated route
 * handlers. Grouped by surface. Dotted lowercase, matching the existing
 * action strings verbatim (this catalog reflects current names — action
 * renames / taxonomy cleanup are out of scope).
 */
export type AuditAction =
  // ai
  | "ai.workflow.generated"
  | "ai.workflow.explained"
  | "ai.workflow.reviewed"
  | "ai.workflow.patch_suggested"
  | "ai.workflow.improvement_suggested"
  | "ai.run.explained"
  // alerts
  | "alert.policy.created"
  | "alert.policy.updated"
  | "alert.policy.deleted"
  // auto-healing
  | "auto_healing.scan.triggered"
  | "auto_healing.decline.manual"
  // billing
  | "billing.budget.configured"
  // credentials
  | "credential.created"
  | "credential.bulk_updated"
  // dlq / recovery replay
  | "dlq.resolved"
  | "dlq.replayed"
  | "recovery.validation_started"
  | "recovery.cluster_apply"
  // mcp
  | "mcp.connection.created"
  | "mcp.connection.updated"
  | "mcp.connection.expose_to_ai_set"
  | "mcp.connection.deleted"
  | "mcp.connection.rediscovered"
  | "mcp.tool.enabled"
  | "mcp.tool.disabled"
  | "mcp.tool.rate_limit_set"
  | "mcp.tool.expose_to_ai_set"
  // members
  | "invitation.created"
  | "invitation.revoked"
  | "member.self_modification_blocked"
  | "member.role.updated"
  | "member.removed"
  // org config
  | "org.config.updated"
  | "memory.consent.granted"
  | "memory.consent.revoked"
  // plugins
  | "plugin.installed"
  // prompts
  | "prompt.created"
  | "prompt.version_created"
  | "prompt.version_pinned"
  // workflow snippets library
  | "snippet.created"
  | "snippet.updated"
  | "snippet.deleted"
  | "snippet.inserted"
  // recovery handoff (one per RecoveryHandoffDestination)
  | "recovery.handoff.slack"
  | "recovery.handoff.linear"
  | "recovery.handoff.github"
  | "recovery.handoff.webhook"
  // recovery items
  | "recovery.item.acknowledged"
  | "recovery.item.in_progress"
  | "recovery.item.waiting_external"
  | "recovery.item.escalated"
  | "recovery.item.assigned"
  | "recovery.item.resolved"
  | "recovery.item.reopened"
  | "recovery.item.commented"
  // recovery feedback
  | "recovery.feedback"
  // eval datasets (built from opted-in accepted recovery feedback)
  | "eval.dataset.created"
  | "eval.dataset.deleted"
  | "eval.dataset.exported"
  // prompt/model experiments (A/B control-vs-candidate against an eval dataset)
  | "experiment.run.started"
  | "experiment.run.completed"
  | "experiment.run.promotion_suggested"
  // reports
  | "report.run_explain.exported"
  | "report.run_explain.delivered"
  | "report.value_dashboard.exported"
  | "report.evidence.exported"
  | "report.evidence.delivered"
  // retention (per-org daily purge sweep; written by the engine scheduler
  // with the real orgId, userId null — system-actor write, not a route)
  | "retention.purged"
  // roles / permissions
  | "org.role.created"
  | "org.role.updated"
  | "org.role.deleted"
  | "org.permissions.override_set"
  | "org.permissions.override_cleared"
  // runs
  | "run.started"
  | "run.started.adhoc"
  | "run.resumed"
  | "run.cancelled"
  | "replay_lab.started"
  | "replay_lab.fork_started"
  // scim directory admin (authenticated routes; webhook receiver stays on audit())
  | "org.scim.directory_attached"
  | "org.scim.directory_updated"
  | "org.scim.directory_revoked"
  // scim group→role mapping admin (authenticated routes; the webhook-side
  // membership recompute audits via the lower-level audit() with a plain string)
  | "org.scim.group_role_mapping_created"
  | "org.scim.group_role_mapping_updated"
  | "org.scim.group_role_mapping_deleted"
  // bulk on-demand re-derivation of every active member's role
  | "org.scim.resynced"
  // sso connection admin (authenticated routes; callback stays on audit())
  | "org.sso.connection_added"
  | "org.sso.connection_updated"
  | "org.sso.connection_revoked"
  // workflows
  | "workflow.metadata.set"
  | "workflow.folder.renamed"
  | "workflow.folder.deleted"
  | "workflow.saved"
  | "workflow.rolled_back"
  | "workflow.slo.set"
  | "workflow.deleted"
  | "workflow.force_run_during_pause"
  // solution packs (installable, ICP-shaped workflow starters)
  | "workflow.pack_imported"
  | "solution_pack.sample_run_started"
  | "solution_pack.failure_injected"
  // onboarding ("first recovered run" guided checklist)
  | "onboarding.skipped"
  | "onboarding.resumed"
  | "onboarding.restarted"
  | "onboarding.completed"
  // upstream health sources
  | "upstream_health.source.created"
  | "upstream_health.source.updated"
  | "upstream_health.source.deleted"
  // inbound trigger events (email_received / file_dropped / mcp_server_event)
  | "trigger.event.received"
  | "trigger.event.started"
  | "trigger.event.skipped"
  | "trigger.event.replayed";

export type AuditActionOptions = {
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
};

/**
 * Write one audit row for an authenticated route action. The `action`
 * is checked against the closed `AuditAction` catalog; `actor`/`source`
 * are derived from `auth` and merged over the caller's metadata.
 * Delegates to `audit()` — which never throws — so audit failures never
 * break the enclosing route.
 */
export async function auditAction(
  auth: AuthContext,
  action: AuditAction,
  options: AuditActionOptions = {},
): Promise<void> {
  const { targetType, targetId, metadata = {} } = options;
  // Caller metadata first; the derived forensic block wins on key
  // collision so `actor`/`source` are always the authoritative,
  // auth-derived values (never a hand-built shape from the caller).
  const enriched: Record<string, unknown> = {
    ...metadata,
    source: auth.source,
    actor: {
      userId: auth.userId,
      mode: auth.mode,
      serviceTokenSuffix: auth.serviceTokenSuffix,
    },
  };
  await audit(auth.orgId, auth.userId, action, targetType, targetId, enriched);
}
