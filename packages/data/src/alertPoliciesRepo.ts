/**
 * Repository for the `alert_policies` table — operator-declared recovery
 * alerting rules that fan event signals into channels.
 *
 * Used by:
 *  - `apps/api/src/routes/alerts-routes.ts` (admin CRUD)
 *  - `packages/engine/src/alerts/dispatcher.ts` (per-trigger fan-out read)
 *  - `apps/api/src/alerts/scanner.ts` (per-trigger scanner read)
 *
 * Invariants:
 * - Multi-tenant scope: every query filters by `orgId`. The `system`
 *   sentinel orgId is honoured for `limiter.degraded` policies — the
 *   repo never returns rows from one tenant to another.
 * - `trigger` validation lives at the API / shared layer (Zod), NOT in
 *   the DB. The repo does not enforce the closed enum so a new trigger
 *   doesn't require a migration.
 * - `parameters` and `channels` jsonb are stored verbatim. The dispatcher
 *   re-validates per-trigger params via `ALERT_PARAMS_SCHEMAS` before
 *   using them.
 */

import { and, asc, desc, eq } from "drizzle-orm";
import { alertPolicies, db } from "@janusly/db";
import type {
  AlertChannel,
  AlertPolicyConfig,
  AlertTrigger,
} from "@janusly/shared";

export type AlertPolicyRow = typeof alertPolicies.$inferSelect;

/**
 * Hydrated shape returned to API / dispatcher / scanner. Trims the DB
 * row to the typed config the rest of the codebase understands.
 */
export type AlertPolicy = {
  id: string;
  orgId: string;
  name: string;
  trigger: AlertTrigger;
  parameters: Record<string, unknown>;
  channels: AlertChannel[];
  cooldownSeconds: number;
  enabled: boolean;
  createdBy: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

function hydrateRow(row: AlertPolicyRow): AlertPolicy {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    trigger: row.trigger as AlertTrigger,
    parameters: (row.parameters as Record<string, unknown>) ?? {},
    channels: (row.channels as AlertChannel[]) ?? [],
    cooldownSeconds: row.cooldownSeconds,
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** List every policy for an org, ordered alphabetically by name. */
export async function listAlertPolicies(orgId: string): Promise<AlertPolicy[]> {
  const rows = await db
    .select()
    .from(alertPolicies)
    .where(eq(alertPolicies.orgId, orgId))
    .orderBy(asc(alertPolicies.name));
  return rows.map(hydrateRow);
}

/** Fetch a single policy by id, scoped to org. Returns null when absent. */
export async function getAlertPolicyById(
  orgId: string,
  id: string,
): Promise<AlertPolicy | null> {
  const rows = await db
    .select()
    .from(alertPolicies)
    .where(and(eq(alertPolicies.orgId, orgId), eq(alertPolicies.id, id)));
  return rows[0] ? hydrateRow(rows[0]) : null;
}

/**
 * List enabled policies for a (orgId, trigger) pair, ordered by name for
 * stable iteration. Used by both event-driven dispatch and the scanner.
 */
export async function getEnabledPoliciesByTrigger(
  orgId: string,
  trigger: AlertTrigger,
): Promise<AlertPolicy[]> {
  const rows = await db
    .select()
    .from(alertPolicies)
    .where(
      and(
        eq(alertPolicies.orgId, orgId),
        eq(alertPolicies.trigger, trigger),
        eq(alertPolicies.enabled, true),
      ),
    )
    .orderBy(asc(alertPolicies.name));
  return rows.map(hydrateRow);
}

/**
 * List every enabled policy in the org, grouped by trigger. Used by the
 * scanner so a single sweep can dispatch across all state-driven triggers
 * without N round-trips.
 */
export async function listEnabledPoliciesForScan(orgId: string): Promise<AlertPolicy[]> {
  const rows = await db
    .select()
    .from(alertPolicies)
    .where(and(eq(alertPolicies.orgId, orgId), eq(alertPolicies.enabled, true)))
    .orderBy(asc(alertPolicies.trigger), asc(alertPolicies.name));
  return rows.map(hydrateRow);
}

/** List every distinct orgId that has at least one enabled policy. */
export async function listOrgIdsWithEnabledPolicies(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ orgId: alertPolicies.orgId })
    .from(alertPolicies)
    .where(eq(alertPolicies.enabled, true))
    .orderBy(asc(alertPolicies.orgId));
  return rows.map((row) => row.orgId);
}

export type CreateAlertPolicyInput = AlertPolicyConfig & {
  id?: string;
  createdBy?: string | null;
};

/** Insert a new policy. Returns the inserted row hydrated. */
export async function createAlertPolicy(
  orgId: string,
  input: CreateAlertPolicyInput,
): Promise<AlertPolicy> {
  const id = input.id ?? crypto.randomUUID();
  const now = new Date();
  await db.insert(alertPolicies).values({
    id,
    orgId,
    name: input.name,
    trigger: input.trigger,
    parameters: input.parameters,
    channels: input.channels,
    cooldownSeconds: input.cooldownSeconds,
    enabled: input.enabled,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  const row = await getAlertPolicyById(orgId, id);
  if (!row) {
    throw new Error("alert policy missing immediately after insert");
  }
  return row;
}

export type UpdateAlertPolicyInput = Partial<AlertPolicyConfig>;

/**
 * Update an existing policy in place. The route layer is responsible for
 * passing only the fields that should change. Returns the prior + next rows
 * so the audit can record both for traceability.
 */
export async function updateAlertPolicy(
  orgId: string,
  id: string,
  input: UpdateAlertPolicyInput,
): Promise<{ before: AlertPolicy; after: AlertPolicy } | null> {
  const before = await getAlertPolicyById(orgId, id);
  if (!before) return null;
  await db
    .update(alertPolicies)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
      ...(input.parameters !== undefined ? { parameters: input.parameters } : {}),
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
      ...(input.cooldownSeconds !== undefined
        ? { cooldownSeconds: input.cooldownSeconds }
        : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(alertPolicies.orgId, orgId), eq(alertPolicies.id, id)));
  const after = await getAlertPolicyById(orgId, id);
  if (!after) return null;
  return { before, after };
}

/** Delete a policy. Returns the deleted row for audit. */
export async function deleteAlertPolicy(
  orgId: string,
  id: string,
): Promise<AlertPolicy | null> {
  const before = await getAlertPolicyById(orgId, id);
  if (!before) return null;
  await db
    .delete(alertPolicies)
    .where(and(eq(alertPolicies.orgId, orgId), eq(alertPolicies.id, id)));
  return before;
}

/** Convenience read used by the scanner (orders by name for determinism). */
export async function listEnabledPoliciesForOrgAndTrigger(
  orgId: string,
  trigger: AlertTrigger,
): Promise<AlertPolicy[]> {
  return getEnabledPoliciesByTrigger(orgId, trigger);
}

/** Re-export `desc` so callers can sort by `updatedAt` without re-importing. */
export { desc };
