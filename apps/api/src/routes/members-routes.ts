/**
 * Org membership management — list, invite, role change, remove.
 *
 * Admin role on every mutation; list is viewer-or-above. Invite uses
 * the email-as-userId pattern until invite-acceptance is in place.
 *
 * Multi-tenant scope: every query carries `eq(orgMembers.orgId, auth.orgId)`.
 */

import { and, eq } from "drizzle-orm";

import { db, orgMembers } from "@janusly/db";

import { audit } from "../audit";
import { EMAIL_PATTERN, MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import { isRole } from "../permissions";
import type { Route } from "../routes";

export const membersRoutes: Route[] = [
  { method: "GET", match: "/members",
    handler: async ({ res, auth }) => {
      const rows = await db.select().from(orgMembers).where(eq(orgMembers.orgId, auth.orgId));
      return sendJson(res, rows);
    } },
  { method: "POST", match: "/members/invite", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const email = typeof body.email === "string" ? body.email.trim() : "";
      const role = isRole(body.role) ? body.role : "viewer";
      if (!email) return sendJson(res, { error: "email is required" }, 400);
      if (!EMAIL_PATTERN.test(email) || email.length > 254) {
        return sendJson(res, { error: "email format is invalid" }, 400);
      }
      // Until invite-acceptance flow is in place, user_id starts as the email so the
      // member row is queryable by it; replace on first sign-in or accept event.
      const userId = typeof body.userId === "string" && body.userId.trim() ? body.userId.trim() : email;
      const existing = await db.select().from(orgMembers).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      if (existing[0]) return sendJson(res, { error: "Member already exists for this org" }, 409);
      const id = crypto.randomUUID();
      await db.insert(orgMembers).values({ id, orgId: auth.orgId, userId, email, role, invitedBy: auth.userId });
      await audit(auth.orgId, auth.userId, "member.invited", "member", userId, { email, role });
      return sendJson(res, { id });
    } },
  { method: "POST", match: "/members/role", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const userId = typeof body.userId === "string" ? body.userId : "";
      if (!userId) return sendJson(res, { error: "userId is required" }, 400);
      if (!isRole(body.role)) return sendJson(res, { error: "role must be viewer, editor, or admin" }, 400);
      await db.update(orgMembers).set({ role: body.role }).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      await audit(auth.orgId, auth.userId, "member.role.updated", "member", userId, { role: body.role });
      return sendJson(res, { ok: true });
    } },
  { method: "DELETE", match: (url) => url.startsWith("/members"), role: "admin",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const userId = url.searchParams.get("userId");
      if (!userId) return sendJson(res, { error: "userId is required" }, 400);
      await db.delete(orgMembers).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      await audit(auth.orgId, auth.userId, "member.removed", "member", userId);
      return sendJson(res, { ok: true });
    } },
];
