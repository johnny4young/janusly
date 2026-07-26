/**
 * Persistence for signed Slack recovery-item interactions.
 *
 * Used by:
 * - `apps/api/src/routes/slack-interactions-routes.ts` for admin CRUD and
 *   callback identity/replay resolution.
 * - `packages/engine/src/alerts/dispatcher.ts` to verify that an alert's
 *   optional interactive connection is active for the same organization.
 *
 * Invariants:
 * - Admin reads/writes are always organization-scoped.
 * - The callback lookup by opaque connection id is the only cross-tenant
 *   system read; callers must verify Slack's signature and stored team id.
 * - Signing secret values never enter this module or Postgres.
 * - Callback receipts are claimed atomically and expired opportunistically.
 */

import { and, asc, eq, lt } from "drizzle-orm";

import {
  db,
  slackInteractionConnections,
  slackInteractionReceipts,
} from "@janusly/db";
import {
  acknowledgeRecoveryItem,
  assignOwnerRecoveryItem,
  getRecoveryItemById,
  type RecoveryItem,
} from "./recoveryItemsRepo";

export const SLACK_INTERACTION_CONNECTION_NAME_MAX = 120;
export const SLACK_INTERACTION_TEAM_ID_MAX = 64;
export const SLACK_INTERACTION_USER_ID_MAX = 128;
export const SLACK_INTERACTION_USER_MAPPINGS_MAX = 100;
export const SLACK_INTERACTION_CREDENTIAL_NAME_MAX = 200;
export const SLACK_INTERACTION_RECEIPT_TTL_MS = 10 * 60 * 1000;

export type SlackInteractionUserMapping = {
  slackUserId: string;
  userId: string;
};

export type SlackInteractionConnection = typeof slackInteractionConnections.$inferSelect;

function normalizeConnectionFields(input: {
  name: string;
  teamId: string;
  signingCredentialName: string;
}) {
  const normalized = {
    name: input.name.trim(),
    teamId: input.teamId.trim(),
    signingCredentialName: input.signingCredentialName.trim(),
  };
  if (
    normalized.name.length === 0
    || normalized.name.length > SLACK_INTERACTION_CONNECTION_NAME_MAX
    || normalized.teamId.length === 0
    || normalized.teamId.length > SLACK_INTERACTION_TEAM_ID_MAX
    || normalized.signingCredentialName.length === 0
    || normalized.signingCredentialName.length > SLACK_INTERACTION_CREDENTIAL_NAME_MAX
  ) {
    throw new Error("slack_interaction_invalid_connection_fields");
  }
  return normalized;
}

function normalizeMappings(
  mappings: readonly SlackInteractionUserMapping[],
): SlackInteractionUserMapping[] {
  if (mappings.length > SLACK_INTERACTION_USER_MAPPINGS_MAX) {
    throw new Error("slack_interaction_too_many_user_mappings");
  }
  const slackIds = new Set<string>();
  const normalized = mappings.map((mapping) => ({
    slackUserId: mapping.slackUserId.trim(),
    userId: mapping.userId.trim(),
  }));
  for (const mapping of normalized) {
    if (
      mapping.slackUserId.length === 0
      || mapping.slackUserId.length > SLACK_INTERACTION_USER_ID_MAX
      || mapping.userId.length === 0
      || mapping.userId.length > SLACK_INTERACTION_USER_ID_MAX
      || slackIds.has(mapping.slackUserId)
    ) {
      throw new Error("slack_interaction_invalid_user_mapping");
    }
    slackIds.add(mapping.slackUserId);
  }
  return normalized;
}

/** List configured Slack interaction connections for one organization. */
export async function listSlackInteractionConnections(
  orgId: string,
): Promise<SlackInteractionConnection[]> {
  return db.select().from(slackInteractionConnections)
    .where(eq(slackInteractionConnections.orgId, orgId))
    .orderBy(asc(slackInteractionConnections.name))
    .limit(100);
}

/** Get one connection inside an organization. */
export async function getSlackInteractionConnection(
  orgId: string,
  id: string,
): Promise<SlackInteractionConnection | null> {
  const rows = await db.select().from(slackInteractionConnections).where(and(
    eq(slackInteractionConnections.orgId, orgId),
    eq(slackInteractionConnections.id, id),
  )).limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve a public callback's opaque connection id before tenant auth exists.
 * The caller must verify the signing credential and exact stored Slack team.
 */
export async function getSlackInteractionConnectionForCallback(
  id: string,
): Promise<SlackInteractionConnection | null> {
  const rows = await db.select().from(slackInteractionConnections)
    .where(eq(slackInteractionConnections.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Create one connection after route-level member validation. */
export async function createSlackInteractionConnection(input: {
  orgId: string;
  name: string;
  teamId: string;
  signingCredentialName: string;
  userMappings: readonly SlackInteractionUserMapping[];
  enabled: boolean;
  createdBy: string;
}): Promise<SlackInteractionConnection> {
  const now = new Date();
  const fields = normalizeConnectionFields(input);
  const rows = await db.insert(slackInteractionConnections).values({
    id: crypto.randomUUID(),
    orgId: input.orgId,
    ...fields,
    userMappings: normalizeMappings(input.userMappings),
    enabled: input.enabled,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (!rows[0]) throw new Error("slack_interaction_create_failed");
  return rows[0];
}

/** Update mutable connection configuration inside one organization. */
export async function updateSlackInteractionConnection(input: {
  orgId: string;
  id: string;
  name: string;
  teamId: string;
  signingCredentialName: string;
  userMappings: readonly SlackInteractionUserMapping[];
  enabled: boolean;
}): Promise<SlackInteractionConnection | null> {
  const fields = normalizeConnectionFields(input);
  const rows = await db.update(slackInteractionConnections).set({
    ...fields,
    userMappings: normalizeMappings(input.userMappings),
    enabled: input.enabled,
    updatedAt: new Date(),
  }).where(and(
    eq(slackInteractionConnections.orgId, input.orgId),
    eq(slackInteractionConnections.id, input.id),
  )).returning();
  return rows[0] ?? null;
}

/** Delete a connection and its operationally meaningless replay receipts. */
export async function deleteSlackInteractionConnection(
  orgId: string,
  id: string,
): Promise<SlackInteractionConnection | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.delete(slackInteractionConnections).where(and(
      eq(slackInteractionConnections.orgId, orgId),
      eq(slackInteractionConnections.id, id),
    )).returning();
    if (!rows[0]) return null;
    await tx.delete(slackInteractionReceipts).where(and(
      eq(slackInteractionReceipts.orgId, orgId),
      eq(slackInteractionReceipts.connectionId, id),
    ));
    return rows[0];
  });
}

/** Return the mapped Janusly user id for one signed Slack principal. */
export function resolveSlackInteractionUser(
  connection: SlackInteractionConnection,
  slackUserId: string,
): string | null {
  return connection.userMappings.find((mapping) => mapping.slackUserId === slackUserId)?.userId ?? null;
}

export type SlackRecoveryInteractionAction = "acknowledge" | "assign_to_me";

export type ApplySlackRecoveryInteractionResult =
  | { kind: "duplicate" }
  | { kind: "not_found" }
  | { kind: "invalid_transition"; currentStatus: string }
  | { kind: "applied"; before: RecoveryItem; after: RecoveryItem };

/**
 * Claim one signed callback and apply its recovery mutation atomically.
 * A process crash cannot leave a consumed receipt without the corresponding
 * state transition, and two API replicas cannot both mutate the same action.
 */
export async function applySlackRecoveryInteraction(input: {
  id: string;
  orgId: string;
  connectionId: string;
  recoveryItemId: string;
  userId: string;
  action: SlackRecoveryInteractionAction;
  now?: Date;
}): Promise<ApplySlackRecoveryInteractionResult> {
  const now = input.now ?? new Date();
  const cutoff = new Date(now.getTime() - SLACK_INTERACTION_RECEIPT_TTL_MS);
  return db.transaction(async (tx) => {
    const connections = await tx.select({ id: slackInteractionConnections.id })
      .from(slackInteractionConnections)
      .where(and(
        eq(slackInteractionConnections.id, input.connectionId),
        eq(slackInteractionConnections.orgId, input.orgId),
        eq(slackInteractionConnections.enabled, true),
      ))
      .limit(1);
    if (!connections[0]) return { kind: "not_found" };
    await tx.delete(slackInteractionReceipts).where(and(
      eq(slackInteractionReceipts.orgId, input.orgId),
      eq(slackInteractionReceipts.connectionId, input.connectionId),
      lt(slackInteractionReceipts.createdAt, cutoff),
    ));
    const receipts = await tx.insert(slackInteractionReceipts).values({
      id: input.id,
      orgId: input.orgId,
      connectionId: input.connectionId,
      createdAt: now,
    }).onConflictDoNothing({ target: slackInteractionReceipts.id }).returning({
      id: slackInteractionReceipts.id,
    });
    if (receipts.length === 0) return { kind: "duplicate" };

    const transition = input.action === "acknowledge"
      ? await acknowledgeRecoveryItem(input.orgId, input.recoveryItemId, {}, tx)
      : await assignOwnerRecoveryItem(
          input.orgId,
          input.recoveryItemId,
          { owner: input.userId },
          tx,
        );
    if (transition) {
      return { kind: "applied", before: transition.before, after: transition.after };
    }
    const current = await getRecoveryItemById(input.orgId, input.recoveryItemId, tx);
    return current
      ? { kind: "invalid_transition", currentStatus: current.status }
      : { kind: "not_found" };
  });
}
