/**
 * Credential CRUD + health snapshot — name-and-secret-ref pairs that
 * integration tools dereference at runtime via `process.env[secretRef]`.
 * The actual secret value never lives in this table; only the env-var
 * name does, and the name itself is never echoed on the wire.
 *
 * The ``GET /credentials/health`` route surfaces broken / stale
 * credentials BEFORE a run trips over them. The route's resolver is
 * the single chokepoint that touches ``process.env`` for credential
 * health; the data layer never reads env directly.
 */

import { and, eq } from "drizzle-orm";

import { credentials, db } from "@janusly/db";
import {
  getCredentialHealth,
  resolveCredentialReferences,
  rotateCredentialSecretRef,
  withAuditTx,
} from "@janusly/data";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { productionSecretRefResolver } from "../readiness-helpers";
import type { Route } from "../routes";

/** Env-var NAME (not a value): a credential's `secretRef` points at this. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_MAX = 256;

export const credentialsRoutes: Route[] = [
  { method: "GET", match: "/credentials", role: "viewer", permission: "credentials.read",
    handler: async ({ res, auth }) => {
      // Project the SELECT to OMIT ``secret_ref`` — the env-var name is
      // the load-bearing security property called out at the top of
      // this file. Operators see the credential's ``name`` / ``kind`` /
      // ``metadata`` and inspect health via ``/credentials/health``
      // which carries ``secretRefPresent: boolean`` (never the name).
      const rows = await db
        .select({
          id: credentials.id,
          orgId: credentials.orgId,
          name: credentials.name,
          kind: credentials.kind,
          metadata: credentials.metadata,
          createdBy: credentials.createdBy,
          createdAt: credentials.createdAt,
        })
        .from(credentials)
        .where(eq(credentials.orgId, auth.orgId));
      return sendJson(res, rows);
    } },
  { method: "GET", match: "/credentials/health", role: "viewer", permission: "credentials.read",
    handler: async ({ res, auth }) => {
      const snapshot = await getCredentialHealth(auth.orgId, productionSecretRefResolver);
      return sendJson(res, snapshot);
    } },
  { method: "POST", match: "/credentials", role: "admin", permission: "credentials.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof body.name !== "string" || typeof body.kind !== "string" || typeof body.secretRef !== "string") {
        return sendError(res, "credentials_fields_required", "name, kind, and secretRef are required", 400);
      }
      const id = crypto.randomUUID();
      await db.insert(credentials).values({ id, orgId: auth.orgId, name: body.name, kind: body.kind, secretRef: body.secretRef, metadata: body.metadata ?? {}, createdBy: auth.userId });
      await auditAction(auth, "credential.created", { targetType: "credential", targetId: id, metadata: { kind: body.kind } });
      return sendJson(res, { id });
    } },
  // Bulk credential rotation: preview the blast radius (dryRun), then commit
  // a single secret-ref swap guarded by optimistic concurrency. The secret
  // VALUE never enters/leaves — only the env-var NAME, which (per this file's
  // header) is itself never echoed: the response carries the affected-workflow
  // list + the new concurrency token, never `secretRef`.
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
        .select({ kind: credentials.kind, updatedAt: credentials.updatedAt })
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

      const newSecretRef = typeof body.newSecretRef === "string" ? body.newSecretRef : "";
      if (!ENV_VAR_NAME.test(newSecretRef) || newSecretRef.length > ENV_VAR_NAME_MAX) {
        return sendError(res, "credentials_invalid_secret_ref", "newSecretRef must be a valid environment variable name", 400);
      }
      if (!ifMatch) {
        return sendError(res, "credentials_if_match_required", "ifMatch is required — send the updatedAt token from the dry-run preview response", 400);
      }
      if (Number.isNaN(new Date(ifMatch).getTime())) {
        return sendError(res, "credentials_if_match_invalid", "ifMatch must be a valid ISO updatedAt token from the dry-run preview", 400);
      }

      const affected = await resolveCredentialReferences(auth.orgId, name);
      // Atomic: the secret-ref swap + the `credential.bulk_updated` audit row
      // commit-or-rollback together (so a swap can never go un-audited on an
      // audit-sink failure). Business outcomes (not_found / conflict) return
      // normally — the tx then commits an empty change with no audit row.
      const txOutcome = await withAuditTx(async (tx, audit) => {
        const result = await rotateCredentialSecretRef(
          { orgId: auth.orgId, name, newSecretRef, ifMatchUpdatedAt: ifMatch },
          tx,
        );
        if (!result.ok) return { kind: result.reason } as const;
        await audit({
          orgId: auth.orgId,
          userId: auth.userId,
          action: "credential.bulk_updated",
          targetType: "credential",
          targetId: name,
          // Mirror auditAction's forensic enrichment so the tx-bound row keeps
          // the same actor/source shape as every other route audit.
          metadata: {
            kind: cred.kind,
            affectedWorkflowIds: affected.map((a) => a.workflowId),
            affectedWorkflowCount: affected.length,
            source: auth.source,
            actor: { userId: auth.userId, mode: auth.mode, serviceTokenSuffix: auth.serviceTokenSuffix },
          },
        });
        return { kind: "ok", updatedAt: result.updatedAt } as const;
      });

      if (!txOutcome.ok) {
        // Real transaction/audit failure — the rollback already reverted the swap.
        return sendError(res, "credentials_rotation_failed", "Credential rotation failed", 500);
      }
      const outcome = txOutcome.result;
      if (outcome.kind === "not_found") return sendError(res, "credentials_not_found", "credential not found", 404);
      if (outcome.kind === "conflict") {
        return sendError(res, "credential_rotation_conflict", "Credential changed since preview; re-preview before rotating", 409);
      }
      // Never echo secretRef (old or new) — the operator supplied the new one
      // and the env-var name is not for the wire (see file header).
      return sendJson(res, {
        ok: true,
        credentialName: name,
        affected,
        affectedCount: affected.length,
        updatedAt: outcome.updatedAt,
      });
    } },
];
