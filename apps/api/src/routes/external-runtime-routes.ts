/**
 * Signed lifecycle ingestion and read-only shadow projections for workflows
 * owned by external runtimes.
 *
 * Configuration routes require explicit tenant permissions. The public
 * callback resolves only an opaque connection id, verifies the exact raw-body
 * HMAC with a dedicated credential, validates the runtime-neutral event
 * contract, and atomically records idempotent/monotonic projections.
 */

import { ExternalRuntimeEventSchema } from "@janusly/shared";
import { z } from "zod";

import {
  createExternalRuntimeConnection,
  deleteExternalRuntimeConnection,
  EXTERNAL_RUNTIME_CONNECTION_NAME_MAX,
  EXTERNAL_RUNTIME_CREDENTIAL_NAME_MAX,
  EXTERNAL_RUNTIME_KEY_MAX,
  getCredentialByName,
  getExternalRuntimeConnection,
  getExternalRuntimeConnectionForCallback,
  hasCredentialSecretRef,
  listExternalRecoveryCases,
  listExternalRunSteps,
  listExternalRuns,
  listExternalRuntimeConnections,
  listExternalWorkflows,
  recordExternalRuntimeEvent,
  resolveCredentialSecretRef,
  updateExternalRuntimeConnection,
  type ExternalRuntimeConnection,
} from "@janusly/data";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { verifyExternalRuntimeSignature } from "../external-runtime-signature";
import { asRecord, readJson, readRawBody, sendError, sendJson } from "../http";
import type { Route } from "../routes";

const EXTERNAL_RUNTIME_BODY_MAX_BYTES = 128_000;
const ADMIN_PATH = /^\/integrations\/external-runtimes\/([^/?]+)$/;
const CALLBACK_PATH = /^\/webhooks\/external-runtimes\/([^/?]+)$/;

const ConnectionBodySchema = z.object({
  name: z.string().trim().min(1).max(EXTERNAL_RUNTIME_CONNECTION_NAME_MAX),
  runtimeKey: z.string().trim().min(1).max(EXTERNAL_RUNTIME_KEY_MAX)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
  signingCredentialName: z.string().trim().min(1).max(EXTERNAL_RUNTIME_CREDENTIAL_NAME_MAX),
  enabled: z.boolean().default(true),
}).strict();

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
  return `/webhooks/external-runtimes/${encodeURIComponent(id)}`;
}

function publicCallbackUrl(id: string): string {
  const path = publicCallbackPath(id);
  const base = (process.env.JANUSLY_PUBLIC_API_URL ?? "").trim().replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

function projectConnection(connection: ExternalRuntimeConnection) {
  return {
    id: connection.id,
    name: connection.name,
    runtimeKey: connection.runtimeKey,
    signingCredentialName: connection.signingCredentialName,
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

async function hasSigningCredential(orgId: string, name: string): Promise<boolean> {
  const credential = await getCredentialByName(
    orgId,
    "external_runtime_signing_secret",
    name,
  );
  return Boolean(
    credential && await hasCredentialSecretRef(orgId, credential.secretRef),
  );
}

async function readShadow(orgId: string) {
  const [connections, workflows, runs, steps, cases] = await Promise.all([
    listExternalRuntimeConnections(orgId),
    listExternalWorkflows(orgId),
    listExternalRuns(orgId),
    listExternalRunSteps(orgId),
    listExternalRecoveryCases(orgId),
  ]);
  return {
    observerOnly: true,
    connections: connections.map(projectConnection),
    workflows,
    runs,
    steps,
    cases,
  };
}

export const externalRuntimeRoutes: Route[] = [
  {
    method: "POST",
    match: url => CALLBACK_PATH.test(url.split("?", 1)[0] ?? ""),
    skipAuth: true,
    handler: async ({ req, res }) => {
      const connectionId = pathId(req.url, CALLBACK_PATH);
      if (!connectionId) {
        return sendError(res, "external_runtime_invalid_request", "invalid callback path", 400);
      }
      const connection = await getExternalRuntimeConnectionForCallback(connectionId);
      if (!connection || !connection.enabled) {
        return sendError(res, "external_runtime_not_found", "external runtime connection not found", 404);
      }
      const credential = await getCredentialByName(
        connection.orgId,
        "external_runtime_signing_secret",
        connection.signingCredentialName,
      );
      const secret = credential
        ? await resolveCredentialSecretRef(connection.orgId, credential.secretRef) ?? ""
        : "";
      const rawBody = await readRawBody(req, EXTERNAL_RUNTIME_BODY_MAX_BYTES);
      const signatureHeader = req.headers["x-janusly-signature"];
      const verification = verifyExternalRuntimeSignature({
        signatureHeader: Array.isArray(signatureHeader)
          ? signatureHeader[0] ?? null
          : signatureHeader ?? null,
        rawBody,
        secret,
      });
      if (!verification.valid) {
        return sendError(
          res,
          "external_runtime_invalid_signature",
          "invalid external runtime signature",
          401,
        );
      }

      let json: unknown;
      try {
        json = JSON.parse(rawBody);
      } catch {
        return sendError(res, "external_runtime_invalid_request", "invalid JSON event", 400);
      }
      const parsed = ExternalRuntimeEventSchema.safeParse(json);
      if (!parsed.success) {
        return sendError(
          res,
          "external_runtime_invalid_request",
          "invalid external runtime event",
          400,
        );
      }
      let result;
      try {
        result = await recordExternalRuntimeEvent({
          orgId: connection.orgId,
          connectionId: connection.id,
          event: parsed.data,
        });
      } catch (error) {
        if (error instanceof Error && error.message === "external_runtime_sensitive_identity") {
          return sendError(
            res,
            "external_runtime_invalid_request",
            "external runtime identity contains sensitive material",
            400,
          );
        }
        throw error;
      }
      if (result.kind === "connection_not_found") {
        return sendError(
          res,
          "external_runtime_not_found",
          "external runtime connection not found",
          404,
        );
      }
      return sendJson(res, {
        accepted: true,
        duplicate: result.kind === "duplicate",
        projectionState: result.kind === "duplicate"
          ? result.receipt.projectionState
          : result.kind,
        eventId: result.receipt.eventId,
        receivedAt: result.receipt.receivedAt,
      }, 202);
    },
  },
  {
    method: "GET",
    match: "/integrations/external-runtimes",
    permission: "external-runtimes.read",
    handler: async ({ res, auth }) => sendJson(res, await readShadow(auth.orgId)),
  },
  {
    method: "POST",
    match: "/integrations/external-runtimes",
    role: "admin",
    permission: "external-runtimes.write",
    handler: async ({ req, res, auth }) => {
      const parsed = ConnectionBodySchema.safeParse(
        asRecord(await readJson(req, MAX_JSON_BODY_BYTES)),
      );
      if (!parsed.success) {
        return sendError(
          res,
          "external_runtime_invalid_request",
          "invalid external runtime connection",
          400,
        );
      }
      if (!(await hasSigningCredential(auth.orgId, parsed.data.signingCredentialName))) {
        return sendError(
          res,
          "external_runtime_invalid_request",
          "external runtime signing credential not found",
          422,
        );
      }
      try {
        const connection = await createExternalRuntimeConnection({
          orgId: auth.orgId,
          ...parsed.data,
          createdBy: auth.userId,
        });
        await auditAction(auth, "external_runtime.connection.created", {
          targetType: "external-runtime-connection",
          targetId: connection.id,
          metadata: { runtimeKey: connection.runtimeKey, enabled: connection.enabled },
        });
        return sendJson(res, { connection: projectConnection(connection) }, 201);
      } catch (error) {
        if (isUniqueViolation(error)) {
          return sendError(
            res,
            "external_runtime_conflict",
            "connection name or runtime key already exists",
            409,
          );
        }
        throw error;
      }
    },
  },
  {
    method: "POST",
    match: url => ADMIN_PATH.test(url.split("?", 1)[0] ?? ""),
    role: "admin",
    permission: "external-runtimes.write",
    handler: async ({ req, res, auth }) => {
      const id = pathId(req.url, ADMIN_PATH);
      if (!id) return sendError(res, "external_runtime_invalid_request", "invalid connection id", 400);
      const existing = await getExternalRuntimeConnection(auth.orgId, id);
      if (!existing) {
        return sendError(res, "external_runtime_not_found", "external runtime connection not found", 404);
      }
      const parsed = ConnectionBodySchema.safeParse(
        asRecord(await readJson(req, MAX_JSON_BODY_BYTES)),
      );
      if (!parsed.success) {
        return sendError(
          res,
          "external_runtime_invalid_request",
          "invalid external runtime connection",
          400,
        );
      }
      if (!(await hasSigningCredential(auth.orgId, parsed.data.signingCredentialName))) {
        return sendError(
          res,
          "external_runtime_invalid_request",
          "external runtime signing credential not found",
          422,
        );
      }
      try {
        const connection = await updateExternalRuntimeConnection({
          orgId: auth.orgId,
          id,
          ...parsed.data,
        });
        if (!connection) {
          return sendError(res, "external_runtime_not_found", "external runtime connection not found", 404);
        }
        await auditAction(auth, "external_runtime.connection.updated", {
          targetType: "external-runtime-connection",
          targetId: connection.id,
          metadata: {
            before: { runtimeKey: existing.runtimeKey, enabled: existing.enabled },
            after: { runtimeKey: connection.runtimeKey, enabled: connection.enabled },
          },
        });
        return sendJson(res, { connection: projectConnection(connection) });
      } catch (error) {
        if (isUniqueViolation(error)) {
          return sendError(
            res,
            "external_runtime_conflict",
            "connection name or runtime key already exists",
            409,
          );
        }
        throw error;
      }
    },
  },
  {
    method: "DELETE",
    match: url => ADMIN_PATH.test(url.split("?", 1)[0] ?? ""),
    role: "admin",
    permission: "external-runtimes.write",
    handler: async ({ req, res, auth }) => {
      const id = pathId(req.url, ADMIN_PATH);
      if (!id) return sendError(res, "external_runtime_invalid_request", "invalid connection id", 400);
      const deleted = await deleteExternalRuntimeConnection(auth.orgId, id);
      if (!deleted) {
        return sendError(res, "external_runtime_not_found", "external runtime connection not found", 404);
      }
      await auditAction(auth, "external_runtime.connection.deleted", {
        targetType: "external-runtime-connection",
        targetId: deleted.id,
        metadata: { runtimeKey: deleted.runtimeKey },
      });
      return sendJson(res, { ok: true });
    },
  },
];
