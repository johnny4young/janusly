/**
 * Credential CRUD — name-and-secret-ref pairs that integration tools
 * dereference at runtime via `process.env[secretRef]`. The actual
 * secret value never lives here; only the env-var name does.
 *
 * Admin role on POST so non-admins can't create credential rows that
 * point at arbitrary env vars.
 */

import { eq } from "drizzle-orm";

import { credentials, db } from "@janusly/db";

import { audit } from "../audit";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import type { Route } from "../routes";

export const credentialsRoutes: Route[] = [
  { method: "GET", match: "/credentials",
    handler: async ({ res, auth }) => {
      const rows = await db.select().from(credentials).where(eq(credentials.orgId, auth.orgId));
      return sendJson(res, rows);
    } },
  { method: "POST", match: "/credentials", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      if (typeof body.name !== "string" || typeof body.kind !== "string" || typeof body.secretRef !== "string") {
        return sendJson(res, { error: "name, kind, and secretRef are required" }, 400);
      }
      const id = crypto.randomUUID();
      await db.insert(credentials).values({ id, orgId: auth.orgId, name: body.name, kind: body.kind, secretRef: body.secretRef, metadata: body.metadata ?? {}, createdBy: auth.userId });
      await audit(auth.orgId, auth.userId, "credential.created", "credential", id, { kind: body.kind });
      return sendJson(res, { id });
    } },
];
