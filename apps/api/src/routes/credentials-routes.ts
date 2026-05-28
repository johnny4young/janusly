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

import { eq } from "drizzle-orm";

import { credentials, db } from "@janusly/db";
import {
  getCredentialHealth,
} from "@janusly/data";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import { productionSecretRefResolver } from "../readiness-helpers";
import type { Route } from "../routes";

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
        return sendJson(res, { error: "name, kind, and secretRef are required" }, 400);
      }
      const id = crypto.randomUUID();
      await db.insert(credentials).values({ id, orgId: auth.orgId, name: body.name, kind: body.kind, secretRef: body.secretRef, metadata: body.metadata ?? {}, createdBy: auth.userId });
      await auditAction(auth, "credential.created", { targetType: "credential", targetId: id, metadata: { kind: body.kind } });
      return sendJson(res, { id });
    } },
];
