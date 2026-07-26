/**
 * Slack recovery-action connection management and signed callback receiver.
 *
 * Admin routes configure a team, a dedicated signing-secret credential, and
 * bounded Slack-user → Janusly-member mappings. The public callback resolves
 * only an opaque connection id, verifies Slack's exact raw-body HMAC + team,
 * authorizes the mapped member through the normal role/permission layer, and
 * atomically claims replay protection with the recovery-item mutation.
 */

import { z } from "zod";

import {
  applySlackRecoveryInteraction,
  createSlackInteractionConnection,
  deleteSlackInteractionConnection,
  getCredentialByName,
  hasCredentialSecretRef,
  getMembershipForOrgUser,
  getSlackInteractionConnection,
  getSlackInteractionConnectionForCallback,
  listSlackInteractionConnections,
  resolveSlackInteractionUser,
  resolveCredentialSecretRef,
  SLACK_INTERACTION_CONNECTION_NAME_MAX,
  SLACK_INTERACTION_CREDENTIAL_NAME_MAX,
  SLACK_INTERACTION_TEAM_ID_MAX,
  SLACK_INTERACTION_USER_ID_MAX,
  SLACK_INTERACTION_USER_MAPPINGS_MAX,
  updateSlackInteractionConnection,
  type SlackInteractionConnection,
} from "@janusly/data";

import { audit } from "../audit";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, readRawBody, sendError, sendJson } from "../http";
import { requirePermission, requireRole } from "../permissions";
import type { Route } from "../routes";
import {
  buildSlackInteractionReceiptId,
  parseSlackInteractionPayload,
  SLACK_ACTION_ACKNOWLEDGE,
  SLACK_ACTION_OPEN,
  verifySlackInteractionSignature,
} from "../slack-interactions";

const SLACK_INTERACTION_BODY_MAX_BYTES = 64_000;
const UserMappingSchema = z.object({
  slackUserId: z.string().trim().min(1).max(SLACK_INTERACTION_USER_ID_MAX),
  userId: z.string().trim().min(1).max(SLACK_INTERACTION_USER_ID_MAX),
}).strict();

const ConnectionBodySchema = z.object({
  name: z.string().trim().min(1).max(SLACK_INTERACTION_CONNECTION_NAME_MAX),
  teamId: z.string().trim().min(1).max(SLACK_INTERACTION_TEAM_ID_MAX)
    .regex(/^[A-Za-z0-9_-]+$/),
  signingCredentialName: z.string().trim().min(1).max(SLACK_INTERACTION_CREDENTIAL_NAME_MAX),
  userMappings: z.array(UserMappingSchema).max(SLACK_INTERACTION_USER_MAPPINGS_MAX),
  enabled: z.boolean().default(true),
}).strict().superRefine((value, ctx) => {
  const seen = new Set<string>();
  for (const [index, mapping] of value.userMappings.entries()) {
    if (seen.has(mapping.slackUserId)) {
      ctx.addIssue({
        code: "custom",
        path: ["userMappings", index, "slackUserId"],
        message: "duplicate Slack user mapping",
      });
    }
    seen.add(mapping.slackUserId);
  }
});

const ADMIN_PATH = /^\/integrations\/slack\/interactions\/([^/?]+)$/;
const CALLBACK_PATH = /^\/webhooks\/slack\/interactions\/([^/?]+)$/;

function pathId(url: string | undefined, pattern: RegExp): string | null {
  const match = pattern.exec((url ?? "").split("?", 1)[0] ?? "");
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

function publicCallbackPath(id: string): string {
  return `/webhooks/slack/interactions/${encodeURIComponent(id)}`;
}

function publicCallbackUrl(id: string): string {
  const path = publicCallbackPath(id);
  const base = (process.env.JANUSLY_PUBLIC_API_URL ?? "").trim().replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

function projectConnection(connection: SlackInteractionConnection) {
  return {
    id: connection.id,
    name: connection.name,
    teamId: connection.teamId,
    signingCredentialName: connection.signingCredentialName,
    userMappings: connection.userMappings,
    enabled: connection.enabled,
    callbackUrl: publicCallbackUrl(connection.id),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; cause?: { code?: unknown } };
  return record.code === "23505" || record.cause?.code === "23505";
}

async function validateConnectionReferences(input: {
  orgId: string;
  currentUserId: string;
  authMode: string;
  signingCredentialName: string;
  userMappings: Array<{ slackUserId: string; userId: string }>;
}): Promise<"ok" | "credential_not_found" | "member_not_found"> {
  const credential = await getCredentialByName(
    input.orgId,
    "slack_signing_secret",
    input.signingCredentialName,
  );
  if (!credential || !(await hasCredentialSecretRef(input.orgId, credential.secretRef))) {
    return "credential_not_found";
  }
  for (const mapping of input.userMappings) {
    const member = await getMembershipForOrgUser({ orgId: input.orgId, userId: mapping.userId });
    const localDevSelf = input.authMode === "dev-headers" && mapping.userId === input.currentUserId;
    if (!member && !localDevSelf) return "member_not_found";
  }
  return "ok";
}

async function auditRejectedCallback(
  connection: SlackInteractionConnection,
  reason: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await audit(
    connection.orgId,
    "slack:interaction",
    "slack.interaction.rejected",
    "slack-interaction",
    connection.id,
    { reason, ...metadata },
  );
}

export const slackInteractionsRoutes: Route[] = [
  {
    method: "POST",
    match: url => CALLBACK_PATH.test(url.split("?", 1)[0] ?? ""),
    skipAuth: true,
    handler: async ({ req, res }) => {
      const connectionId = pathId(req.url, CALLBACK_PATH);
      if (!connectionId) return sendError(res, "slack_interaction_invalid_request", "invalid callback path", 400);
      const connection = await getSlackInteractionConnectionForCallback(connectionId);
      if (!connection || !connection.enabled) {
        return sendError(res, "slack_interaction_not_found", "interaction connection not found", 404);
      }
      const credential = await getCredentialByName(
        connection.orgId,
        "slack_signing_secret",
        connection.signingCredentialName,
      );
      const secret = credential
        ? await resolveCredentialSecretRef(connection.orgId, credential.secretRef) ?? ""
        : "";
      const rawBody = await readRawBody(req, SLACK_INTERACTION_BODY_MAX_BYTES);
      const timestampHeader = req.headers["x-slack-request-timestamp"];
      const signatureHeader = req.headers["x-slack-signature"];
      const verification = verifySlackInteractionSignature({
        timestampHeader: Array.isArray(timestampHeader) ? timestampHeader[0] ?? null : timestampHeader ?? null,
        signatureHeader: Array.isArray(signatureHeader) ? signatureHeader[0] ?? null : signatureHeader ?? null,
        rawBody,
        secret,
      });
      if (!verification.valid) {
        return sendError(res, "slack_interaction_invalid_signature", "invalid Slack signature", 401);
      }
      const payload = parseSlackInteractionPayload(rawBody);
      if (!payload) {
        await auditRejectedCallback(connection, "invalid_payload");
        return sendError(res, "slack_interaction_invalid_request", "invalid Slack interaction payload", 400);
      }
      if (payload.team.id !== connection.teamId) {
        await auditRejectedCallback(connection, "team_mismatch", { signedTeamId: payload.team.id });
        return sendError(res, "slack_interaction_unauthorized", "Slack team is not authorized", 403);
      }
      const mappedUserId = resolveSlackInteractionUser(connection, payload.user.id);
      if (!mappedUserId) {
        await auditRejectedCallback(connection, "user_unmapped", { slackUserId: payload.user.id });
        return sendError(res, "slack_interaction_unauthorized", "Slack user is not authorized", 403);
      }
      try {
        await requireRole(connection.orgId, mappedUserId, "editor", "supabase");
        await requirePermission(connection.orgId, mappedUserId, "recovery.write", "supabase");
      } catch {
        await auditRejectedCallback(connection, "permission_denied", {
          slackUserId: payload.user.id,
          mappedUserId,
        });
        return sendError(res, "slack_interaction_unauthorized", "mapped user lacks recovery permission", 403);
      }

      const action = payload.actions[0]!;
      if (action.action_id === SLACK_ACTION_OPEN) {
        await audit(
          connection.orgId,
          mappedUserId,
          "slack.interaction.opened",
          "recovery-item",
          action.value,
          {
            source: "slack",
            slack: {
              connectionId: connection.id,
              teamId: connection.teamId,
              slackUserId: payload.user.id,
            },
          },
        );
        return sendJson(res, { ok: true });
      }
      const actionKind = action.action_id === SLACK_ACTION_ACKNOWLEDGE
        ? "acknowledge"
        : "assign_to_me";
      const result = await applySlackRecoveryInteraction({
        id: buildSlackInteractionReceiptId(connection.id, verification.timestamp, rawBody),
        orgId: connection.orgId,
        connectionId: connection.id,
        recoveryItemId: action.value,
        userId: mappedUserId,
        action: actionKind,
      });
      if (result.kind === "duplicate") {
        return sendJson(res, { ok: true, duplicate: true });
      }
      if (result.kind === "not_found") {
        return sendError(res, "recovery_item_not_found", "recovery item not found", 404);
      }
      if (result.kind === "invalid_transition") {
        return sendError(
          res,
          "recovery_item_transition_invalid",
          "recovery action is no longer available",
          409,
          { currentStatus: result.currentStatus },
        );
      }

      const auditActionName = actionKind === "acknowledge"
        ? "recovery.item.acknowledged"
        : "recovery.item.assigned";
      await audit(
        connection.orgId,
        mappedUserId,
        auditActionName,
        "recovery-item",
        action.value,
        {
          before: { status: result.before.status, owner: result.before.owner },
          after: { status: result.after.status, owner: result.after.owner },
          source: "slack",
          slack: {
            connectionId: connection.id,
            teamId: connection.teamId,
            slackUserId: payload.user.id,
          },
        },
      );
      return sendJson(res, {
        ok: true,
        response_type: "ephemeral",
        text: actionKind === "acknowledge"
          ? "Janusly acknowledged the recovery item."
          : "Janusly assigned the recovery item to you.",
      });
    },
  },
  {
    method: "GET",
    match: "/integrations/slack/interactions",
    role: "admin",
    permission: "credentials.write",
    handler: async ({ res, auth }) => {
      const connections = await listSlackInteractionConnections(auth.orgId);
      return sendJson(res, { connections: connections.map(projectConnection) });
    },
  },
  {
    method: "POST",
    match: "/integrations/slack/interactions",
    role: "admin",
    permission: "credentials.write",
    handler: async ({ req, res, auth }) => {
      const parsed = ConnectionBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!parsed.success) {
        return sendError(res, "slack_interaction_invalid_request", "invalid Slack interaction connection", 400);
      }
      const referenceState = await validateConnectionReferences({
        orgId: auth.orgId,
        currentUserId: auth.userId,
        authMode: auth.mode,
        signingCredentialName: parsed.data.signingCredentialName,
        userMappings: parsed.data.userMappings,
      });
      if (referenceState !== "ok") {
        return sendError(
          res,
          "slack_interaction_invalid_request",
          referenceState === "credential_not_found"
            ? "Slack signing credential not found"
            : "mapped Janusly member not found",
          422,
          { reason: referenceState },
        );
      }
      try {
        const connection = await createSlackInteractionConnection({
          orgId: auth.orgId,
          createdBy: auth.userId,
          ...parsed.data,
        });
        await auditAction(auth, "slack.interaction.created", {
          targetType: "slack-interaction",
          targetId: connection.id,
          metadata: {
            teamId: connection.teamId,
            signingCredentialName: connection.signingCredentialName,
            mappingCount: connection.userMappings.length,
            enabled: connection.enabled,
          },
        });
        return sendJson(res, { connection: projectConnection(connection) }, 201);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return sendError(res, "slack_interaction_conflict", "connection name or team already exists", 409);
        }
        throw error;
      }
    },
  },
  {
    method: "POST",
    match: url => ADMIN_PATH.test(url.split("?", 1)[0] ?? ""),
    role: "admin",
    permission: "credentials.write",
    handler: async ({ req, res, auth }) => {
      const id = pathId(req.url, ADMIN_PATH);
      if (!id) return sendError(res, "slack_interaction_invalid_request", "invalid connection id", 400);
      const existing = await getSlackInteractionConnection(auth.orgId, id);
      if (!existing) return sendError(res, "slack_interaction_not_found", "interaction connection not found", 404);
      const parsed = ConnectionBodySchema.safeParse(asRecord(await readJson(req, MAX_JSON_BODY_BYTES)));
      if (!parsed.success) {
        return sendError(res, "slack_interaction_invalid_request", "invalid Slack interaction connection", 400);
      }
      const referenceState = await validateConnectionReferences({
        orgId: auth.orgId,
        currentUserId: auth.userId,
        authMode: auth.mode,
        signingCredentialName: parsed.data.signingCredentialName,
        userMappings: parsed.data.userMappings,
      });
      if (referenceState !== "ok") {
        return sendError(res, "slack_interaction_invalid_request", "connection reference is invalid", 422, {
          reason: referenceState,
        });
      }
      try {
        const updated = await updateSlackInteractionConnection({
          orgId: auth.orgId,
          id,
          ...parsed.data,
        });
        if (!updated) return sendError(res, "slack_interaction_not_found", "interaction connection not found", 404);
        await auditAction(auth, "slack.interaction.updated", {
          targetType: "slack-interaction",
          targetId: id,
          metadata: {
            before: { teamId: existing.teamId, mappingCount: existing.userMappings.length, enabled: existing.enabled },
            after: { teamId: updated.teamId, mappingCount: updated.userMappings.length, enabled: updated.enabled },
          },
        });
        return sendJson(res, { connection: projectConnection(updated) });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return sendError(res, "slack_interaction_conflict", "connection name or team already exists", 409);
        }
        throw error;
      }
    },
  },
  {
    method: "DELETE",
    match: url => ADMIN_PATH.test(url.split("?", 1)[0] ?? ""),
    role: "admin",
    permission: "credentials.write",
    handler: async ({ req, res, auth }) => {
      const id = pathId(req.url, ADMIN_PATH);
      if (!id) return sendError(res, "slack_interaction_invalid_request", "invalid connection id", 400);
      const deleted = await deleteSlackInteractionConnection(auth.orgId, id);
      if (!deleted) return sendError(res, "slack_interaction_not_found", "interaction connection not found", 404);
      await auditAction(auth, "slack.interaction.deleted", {
        targetType: "slack-interaction",
        targetId: id,
        metadata: { teamId: deleted.teamId, mappingCount: deleted.userMappings.length },
      });
      return sendJson(res, { ok: true });
    },
  },
];
