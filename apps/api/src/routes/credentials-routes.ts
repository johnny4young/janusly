/**
 * Credential CRUD + health snapshot.
 *
 * New secrets are accepted once, envelope-encrypted in PostgreSQL, and never
 * returned. Legacy environment-variable references remain supported as an
 * explicit compatibility mode. Neither managed references nor env-var names
 * are echoed on the wire.
 *
 * The ``GET /credentials/health`` route surfaces broken / stale credentials
 * BEFORE a run trips over them. It uses the same organization-aware resolver
 * as runtime integrations, so managed and legacy references cannot drift.
 */

import { and, eq } from "drizzle-orm";

import { credentials, db } from "@janusly/db";
import {
  createCredentialSecretVersion,
  getCredentialHealth,
  isManagedCredentialSecretRef,
  resolveCredentialReferences,
  revokeCredentialSecretRef,
  rotateCredentialSecretRef,
  setCredentialExpiry,
  withAuditTx,
} from "@janusly/data";

import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { productionSecretRefResolver } from "../readiness-helpers";
import type { Route } from "../routes";

/** Env-var NAME (not a value): a credential's `secretRef` points at this. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_MAX = 256;
const SECRET_VALUE_MAX_BYTES = 64 * 1024;
const CREDENTIAL_NAME_MAX = 200;
const CREDENTIAL_KIND_MAX = 100;

type SecretInput =
  | { kind: "managed"; value: string }
  | { kind: "legacy"; ref: string };

function parseSecretInput(
  body: Record<string, unknown>,
  fields: { value: string; ref: string },
): { ok: true; input: SecretInput } | { ok: false; code: "required" | "invalid" } {
  const rawValue = body[fields.value];
  const rawRef = body[fields.ref];
  const hasValue = typeof rawValue === "string";
  const hasRef = typeof rawRef === "string";
  if (hasValue === hasRef) return { ok: false, code: "required" };
  if (typeof rawValue === "string") {
    const bytes = Buffer.byteLength(rawValue, "utf8");
    if (bytes === 0 || bytes > SECRET_VALUE_MAX_BYTES) return { ok: false, code: "invalid" };
    return { ok: true, input: { kind: "managed", value: rawValue } };
  }
  if (typeof rawRef !== "string" || !ENV_VAR_NAME.test(rawRef) || rawRef.length > ENV_VAR_NAME_MAX) {
    return { ok: false, code: "invalid" };
  }
  return { ok: true, input: { kind: "legacy", ref: rawRef } };
}

/**
 * Parse an optional operator-supplied expiry. `undefined` / `null` → no expiry
 * (`date: null`). A string must parse to a valid Date strictly in the future
 * (a past/now date is a config mistake, not a warning target). Anything else
 * (number, object, past date, unparseable) → `{ ok: false }` so the route
 * returns a coded 400. The value is metadata — never a secret.
 */
function parseFutureExpiry(value: unknown): { ok: true; date: Date | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, date: null };
  if (typeof value !== "string") return { ok: false };
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) return { ok: false };
  return { ok: true, date };
}

export const credentialsRoutes: Route[] = [
  { method: "GET", match: "/credentials", role: "viewer", permission: "credentials.read",
    handler: async ({ res, auth }) => {
      // Project the response to OMIT ``secret_ref``. Operators see only the
      // credential's safe metadata and whether storage is managed or legacy;
      // health exposes a boolean rather than either reference form.
      const rows = await db
        .select({
          id: credentials.id,
          orgId: credentials.orgId,
          name: credentials.name,
          kind: credentials.kind,
          secretRef: credentials.secretRef,
          metadata: credentials.metadata,
          createdBy: credentials.createdBy,
          createdAt: credentials.createdAt,
          expiresAt: credentials.expiresAt,
        })
        .from(credentials)
        .where(eq(credentials.orgId, auth.orgId));
      return sendJson(res, rows.map(({ secretRef, ...row }) => ({
        ...row,
        storage: isManagedCredentialSecretRef(secretRef) ? "managed" : "environment",
      })));
    } },
  { method: "GET", match: "/credentials/health", role: "viewer", permission: "credentials.read",
    handler: async ({ res, auth }) => {
      const snapshot = await getCredentialHealth(auth.orgId, productionSecretRefResolver);
      return sendJson(res, snapshot);
    } },
  { method: "POST", match: "/credentials", role: "admin", permission: "credentials.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const kind = typeof body.kind === "string" ? body.kind.trim() : "";
      if (
        !name
        || name.length > CREDENTIAL_NAME_MAX
        || !kind
        || kind.length > CREDENTIAL_KIND_MAX
      ) {
        return sendError(res, "credentials_fields_required", "name, kind, and one secret source are required", 400);
      }
      const secret = parseSecretInput(body, { value: "secretValue", ref: "secretRef" });
      if (!secret.ok) {
        return sendError(
          res,
          secret.code === "required" ? "credentials_fields_required" : "credentials_invalid_secret_ref",
          secret.code === "required"
            ? "Provide exactly one of secretValue or secretRef"
            : "secretValue must be non-empty and at most 64 KiB, or secretRef must be a valid environment variable name",
          400,
        );
      }
      // Optional operator-declared expiry. Must be a future ISO date; omit or
      // null for "no expiry". The value is metadata only — never the secret.
      const parsedExpiry = parseFutureExpiry(body.expiresAt);
      if (!parsedExpiry.ok) {
        return sendError(res, "credentials_invalid_expiry", "expiresAt must be a valid future ISO date or null", 400);
      }
      const id = crypto.randomUUID();
      const txOutcome = await withAuditTx(async (tx, audit) => {
        const secretRef = secret.input.kind === "managed"
          ? (await createCredentialSecretVersion({
              orgId: auth.orgId,
              credentialId: id,
              secretValue: secret.input.value,
              createdBy: auth.userId,
            }, tx)).secretRef
          : secret.input.ref;
        await tx.insert(credentials).values({
          id,
          orgId: auth.orgId,
          name,
          kind,
          secretRef,
          metadata: body.metadata ?? {},
          expiresAt: parsedExpiry.date,
          createdBy: auth.userId,
        });
        await audit({
          orgId: auth.orgId,
          userId: auth.userId,
          action: "credential.created",
          targetType: "credential",
          targetId: id,
          metadata: {
            kind,
            storage: secret.input.kind,
            hasExpiry: parsedExpiry.date !== null,
            source: auth.source,
            actor: { userId: auth.userId, mode: auth.mode, serviceTokenSuffix: auth.serviceTokenSuffix },
          },
        });
      });
      if (!txOutcome.ok) {
        if (txOutcome.error.includes("credentials_org_name_idx")) {
          return sendError(res, "credentials_conflict", "Credential name already exists", 409);
        }
        const unavailable = txOutcome.error.includes("credential_secret_root_key");
        return sendError(
          res,
          unavailable ? "credentials_secret_store_unavailable" : "credentials_create_failed",
          unavailable ? "Managed secret storage is not configured" : "Creating credential failed",
          500,
        );
      }
      return sendJson(res, { id });
    } },
  // Bulk credential rotation: preview the blast radius, then commit one
  // managed secret value or legacy env reference under optimistic concurrency.
  // Secret material enters once and is never returned or audited.
  { method: "POST", match: (url) => /^\/credentials\/[^/?]+\/bulk-update(\?|$)/.test(url), role: "admin", permission: "credentials.write",
    handler: async ({ req, res, auth }) => {
      const pathname = new URL(req.url ?? "", "http://internal").pathname;
      const name = decodeURIComponent(pathname.split("/")[2] ?? "");
      if (!name) return sendError(res, "credentials_name_required", "credential name required", 400);

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const dryRun = body.dryRun === true;
      const ifMatch = typeof body.ifMatch === "string" ? body.ifMatch : undefined;

      // Identify the credential by (orgId, name); kind + updatedAt feed the
      // preview + the audit row. Tenant-scoped — another org's name is invisible.
      const rows = await db
        .select({
          id: credentials.id,
          kind: credentials.kind,
          secretRef: credentials.secretRef,
          updatedAt: credentials.updatedAt,
        })
        .from(credentials)
        .where(and(eq(credentials.orgId, auth.orgId), eq(credentials.name, name)))
        .limit(1);
      const cred = rows[0];
      if (!cred) return sendError(res, "credentials_not_found", "credential not found", 404);

      if (dryRun) {
        const affected = await resolveCredentialReferences(auth.orgId, name);
        return sendJson(res, {
          credentialName: name,
          kind: cred.kind,
          updatedAt: cred.updatedAt,
          affected,
          affectedCount: affected.length,
        });
      }

      const secret = parseSecretInput(body, { value: "newSecretValue", ref: "newSecretRef" });
      if (!secret.ok) {
        return sendError(
          res,
          "credentials_invalid_secret_ref",
          secret.code === "required"
            ? "Provide exactly one of newSecretValue or newSecretRef"
            : "newSecretValue must be non-empty and at most 64 KiB, or newSecretRef must be a valid environment variable name",
          400,
        );
      }
      if (!ifMatch) {
        return sendError(res, "credentials_if_match_required", "ifMatch is required — send the updatedAt token from the dry-run preview response", 400);
      }
      if (Number.isNaN(new Date(ifMatch).getTime())) {
        return sendError(res, "credentials_if_match_invalid", "ifMatch must be a valid ISO updatedAt token from the dry-run preview", 400);
      }

      const affected = await resolveCredentialReferences(auth.orgId, name);
      // Atomic: managed-version insert, reference swap, prior-version
      // revocation, and audit row commit or roll back together.
      const txOutcome = await withAuditTx(async (tx, audit) => {
        // Serialize rotations for this credential before assigning the next
        // encrypted-secret version. The row lock also closes the gap between
        // the preview token check and the version insert across API replicas.
        const lockedRows = await tx
          .select({
            id: credentials.id,
            kind: credentials.kind,
            secretRef: credentials.secretRef,
            updatedAt: credentials.updatedAt,
          })
          .from(credentials)
          .where(and(eq(credentials.orgId, auth.orgId), eq(credentials.name, name)))
          .limit(1)
          .for("update");
        const locked = lockedRows[0];
        if (!locked) throw new Error("credential_rotation_not_found");
        if (locked.updatedAt.getTime() !== new Date(ifMatch).getTime()) {
          throw new Error("credential_rotation_conflict");
        }
        const newSecretRef = secret.input.kind === "managed"
          ? (await createCredentialSecretVersion({
              orgId: auth.orgId,
              credentialId: locked.id,
              secretValue: secret.input.value,
              createdBy: auth.userId,
            }, tx)).secretRef
          : secret.input.ref;
        const result = await rotateCredentialSecretRef(
          { orgId: auth.orgId, name, newSecretRef, ifMatchUpdatedAt: ifMatch },
          tx,
        );
        if (!result.ok) throw new Error(`credential_rotation_${result.reason}`);
        await revokeCredentialSecretRef(auth.orgId, locked.secretRef, tx);
        await audit({
          orgId: auth.orgId,
          userId: auth.userId,
          action: "credential.bulk_updated",
          targetType: "credential",
          targetId: name,
          // Mirror auditAction's forensic enrichment so the tx-bound row keeps
          // the same actor/source shape as every other route audit.
          metadata: {
            kind: locked.kind,
            storage: secret.input.kind,
            affectedWorkflowIds: affected.map((a) => a.workflowId),
            affectedWorkflowCount: affected.length,
            source: auth.source,
            actor: { userId: auth.userId, mode: auth.mode, serviceTokenSuffix: auth.serviceTokenSuffix },
          },
        });
        return { updatedAt: result.updatedAt };
      });

      if (!txOutcome.ok) {
        if (txOutcome.error === "credential_rotation_not_found") {
          return sendError(res, "credentials_not_found", "credential not found", 404);
        }
        if (txOutcome.error === "credential_rotation_conflict") {
          return sendError(res, "credential_rotation_conflict", "Credential changed since preview; re-preview before rotating", 409);
        }
        if (txOutcome.error.includes("credential_secret_root_key")) {
          return sendError(res, "credentials_secret_store_unavailable", "Managed secret storage is not configured", 500);
        }
        return sendError(res, "credentials_rotation_failed", "Credential rotation failed", 500);
      }
      return sendJson(res, {
        ok: true,
        credentialName: name,
        affected,
        affectedCount: affected.length,
        updatedAt: txOutcome.result.updatedAt,
      });
    } },
  {
    method: "DELETE",
    match: (url) => /^\/credentials\/[^/?]+(\?|$)/.test(url),
    role: "admin",
    permission: "credentials.write",
    handler: async ({ req, res, auth }) => {
      const pathname = new URL(req.url ?? "", "http://internal").pathname;
      const name = decodeURIComponent(pathname.split("/")[2] ?? "");
      if (!name) return sendError(res, "credentials_name_required", "credential name required", 400);

      const txOutcome = await withAuditTx(async (tx, audit) => {
        const rows = await tx
          .select({ id: credentials.id, kind: credentials.kind, secretRef: credentials.secretRef })
          .from(credentials)
          .where(and(eq(credentials.orgId, auth.orgId), eq(credentials.name, name)))
          .limit(1);
        const credential = rows[0];
        if (!credential) return false;
        const deleted = await tx
          .delete(credentials)
          .where(and(eq(credentials.orgId, auth.orgId), eq(credentials.id, credential.id)))
          .returning({ id: credentials.id });
        if (!deleted[0]) return false;
        await revokeCredentialSecretRef(auth.orgId, credential.secretRef, tx);
        await audit({
          orgId: auth.orgId,
          userId: auth.userId,
          action: "credential.revoked",
          targetType: "credential",
          targetId: credential.id,
          metadata: {
            kind: credential.kind,
            source: auth.source,
            actor: { userId: auth.userId, mode: auth.mode, serviceTokenSuffix: auth.serviceTokenSuffix },
          },
        });
        return true;
      });
      if (!txOutcome.ok) {
        return sendError(res, "credentials_revoke_failed", "Revoking credential failed", 500);
      }
      if (!txOutcome.result) {
        return sendError(res, "credentials_not_found", "credential not found", 404);
      }
      return sendJson(res, { ok: true });
    },
  },
  // Set (or clear, with `expiresAt: null`) a credential's operator-declared
  // expiry. Metadata-only — the secret value + opaque reference are untouched, so
  // no blast-radius preview is needed (unlike rotation). `ifMatch` is OPTIONAL
  // here (low-risk metadata): when supplied it CAS-guards on the updatedAt
  // token; when omitted it's last-write-wins.
  { method: "POST", match: (url) => /^\/credentials\/[^/?]+\/expiry(\?|$)/.test(url), role: "admin", permission: "credentials.write",
    handler: async ({ req, res, auth }) => {
      const pathname = new URL(req.url ?? "", "http://internal").pathname;
      const name = decodeURIComponent(pathname.split("/")[2] ?? "");
      if (!name) return sendError(res, "credentials_name_required", "credential name required", 400);

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      // On the DEDICATED expiry endpoint, clearing must be EXPLICIT: require
      // `expiresAt` to be present (a future ISO date to set, or `null` to
      // clear). Omitting the field is rejected so a partial/accidental request
      // (e.g. `{}` or `{ ifMatch }`) can't silently wipe a live expiry. (The
      // create route treats an omitted `expiresAt` as "no expiry" — correct
      // there, since nothing is being overwritten.)
      if (!("expiresAt" in body)) {
        return sendError(res, "credentials_expiry_required", "expiresAt is required — a future ISO date to set, or null to clear", 400);
      }
      const parsedExpiry = parseFutureExpiry(body.expiresAt);
      if (!parsedExpiry.ok) {
        return sendError(res, "credentials_invalid_expiry", "expiresAt must be a valid future ISO date or null to clear", 400);
      }
      const ifMatch = typeof body.ifMatch === "string" ? body.ifMatch : undefined;
      if (ifMatch && Number.isNaN(new Date(ifMatch).getTime())) {
        return sendError(res, "credentials_if_match_invalid", "ifMatch must be a valid ISO updatedAt token", 400);
      }

      // Atomic: the expiry write + its audit row commit-or-rollback together.
      const txOutcome = await withAuditTx(async (tx, audit) => {
        const result = await setCredentialExpiry(
          { orgId: auth.orgId, name, expiresAt: parsedExpiry.date, ifMatchUpdatedAt: ifMatch },
          tx,
        );
        if (!result.ok) return { kind: result.reason } as const;
        await audit({
          orgId: auth.orgId,
          userId: auth.userId,
          action: "credential.expiry_set",
          targetType: "credential",
          targetId: name,
          metadata: {
            hasExpiry: parsedExpiry.date !== null,
            expiresAt: parsedExpiry.date?.toISOString() ?? null,
            source: auth.source,
            actor: { userId: auth.userId, mode: auth.mode, serviceTokenSuffix: auth.serviceTokenSuffix },
          },
        });
        return { kind: "ok", updatedAt: result.updatedAt } as const;
      });

      if (!txOutcome.ok) {
        return sendError(res, "credentials_expiry_failed", "Setting credential expiry failed", 500);
      }
      const outcome = txOutcome.result;
      if (outcome.kind === "not_found") return sendError(res, "credentials_not_found", "credential not found", 404);
      if (outcome.kind === "conflict") {
        return sendError(res, "credential_expiry_conflict", "Credential changed since load; reload before setting expiry", 409);
      }
      return sendJson(res, {
        ok: true,
        credentialName: name,
        expiresAt: parsedExpiry.date?.toISOString() ?? null,
        updatedAt: outcome.updatedAt,
      });
    } },
];
