/**
 * Org membership management — list, invite, role change, remove.
 *
 * Admin role on every mutation; list is viewer-or-above. Invites land as
 * rows in `invitations` (status `pending`) and are auto-accepted by the
 * membership resolver on the invitee's first Supabase sign-in. Pre-resolver
 * invite rows (`org_members.userId = email` placeholder) get a lazy
 * UUID-backfill via the resolver's legacy-orphan path — those rows keep
 * working, but new invites flow through `invitations`.
 *
 * Multi-tenant scope: every query carries `eq(<table>.orgId, auth.orgId)`.
 */

import { and, eq } from "drizzle-orm";

import { db, orgMembers } from "@janusly/db";
import {
  createInvitation,
  findPendingInvitation,
  listInvitationsByOrg,
  revokeInvitation,
} from "@janusly/data/src/invitationsRepo";

import { audit } from "../audit";
import { EMAIL_PATTERN, MAX_JSON_BODY_BYTES } from "../api-config";
import { errorEnvelope } from "../error-codes";
import { asRecord, readJson, sendJson } from "../http";
import { getOrgRole } from "@janusly/data/src/orgRolesRepo";
import { isRole } from "../permissions";
import type { Route } from "../routes";

export const membersRoutes: Route[] = [
  { method: "GET", match: "/members",
    handler: async ({ res, auth }) => {
      const rows = await db.select().from(orgMembers).where(eq(orgMembers.orgId, auth.orgId));
      return sendJson(res, rows);
    } },
  { method: "GET", match: "/members/invitations", role: "admin",
    handler: async ({ res, auth }) => {
      const rows = await listInvitationsByOrg(auth.orgId);
      return sendJson(res, rows);
    } },
  { method: "POST", match: "/members/invite", role: "admin", permission: "members.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
      const roleName = typeof body.role === "string" ? body.role.trim() : "viewer";
      // Accept built-in roles OR custom roles defined for this org.
      const role = isRole(roleName)
        ? roleName
        : (await getOrgRole({ orgId: auth.orgId, name: roleName }))
          ? roleName
          : null;
      if (!role) {
        return sendJson(res, { error: `role "${roleName}" is not defined for this org` }, 400);
      }
      if (!email) return sendJson(res, errorEnvelope("email_required", "email is required"), 400);
      if (!EMAIL_PATTERN.test(email) || email.length > 254) {
        return sendJson(res, errorEnvelope("email_invalid", "email format is invalid"), 400);
      }
      // Reject re-invites that already have a pending row (avoids
      // collision on the unique (orgId, email) index). A previously
      // accepted invite for the same email is allowed to re-issue (the
      // pending check ignores `accepted` / `revoked`).
      const pending = await findPendingInvitation({ orgId: auth.orgId, email });
      if (pending) return sendJson(res, errorEnvelope("invitation_pending_exists", "Invitation already pending for this email", { email }), 409);
      // Reject when the email already has an accepted membership row
      // (`org_members.email` is set by resolver upserts and by the legacy
      // `userId = email` rows; in both cases the user is already a member
      // of this org).
      const existing = await db
        .select()
        .from(orgMembers)
        .where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.email, email)));
      if (existing[0]) return sendJson(res, errorEnvelope("member_exists", "Member already exists for this org", { email }), 409);

      const invite = await createInvitation({
        orgId: auth.orgId,
        email,
        role,
        invitedBy: auth.userId,
      });
      await audit(auth.orgId, auth.userId, "invitation.created", "invitation", invite.id, {
        email,
        role,
      });
      return sendJson(res, { id: invite.id, status: invite.status });
    } },
  { method: "POST", match: (url) => /^\/members\/invitations\/[^/]+\/revoke$/.test(url), role: "admin", permission: "members.write",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/members\/invitations\/([^/?]+)\/revoke/);
      const id = match?.[1];
      if (!id) return sendJson(res, { error: "invitation id is required" }, 400);
      const ok = await revokeInvitation({ id, orgId: auth.orgId });
      if (!ok) return sendJson(res, { error: "invitation not found or not pending" }, 404);
      await audit(auth.orgId, auth.userId, "invitation.revoked", "invitation", id, {});
      return sendJson(res, { ok: true });
    } },
  { method: "POST", match: "/members/role", role: "admin", permission: "members.role_set",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const userId = typeof body.userId === "string" ? body.userId : "";
      const roleName = typeof body.role === "string" ? body.role.trim() : "";
      if (!userId) return sendJson(res, { error: "userId is required" }, 400);
      // Accept built-in roles OR custom roles defined for this org.
      const accepted = isRole(roleName)
        ? roleName
        : (await getOrgRole({ orgId: auth.orgId, name: roleName }))
          ? roleName
          : null;
      if (!accepted) {
        return sendJson(res, { error: `role "${roleName}" is not defined for this org` }, 400);
      }
      await db.update(orgMembers).set({ role: accepted }).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      await audit(auth.orgId, auth.userId, "member.role.updated", "member", userId, { role: accepted });
      return sendJson(res, { ok: true });
    } },
  { method: "DELETE", match: (url) => url.startsWith("/members"), role: "admin", permission: "members.write",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const userId = url.searchParams.get("userId");
      if (!userId) return sendJson(res, { error: "userId is required" }, 400);
      await db.delete(orgMembers).where(and(eq(orgMembers.orgId, auth.orgId), eq(orgMembers.userId, userId)));
      await audit(auth.orgId, auth.userId, "member.removed", "member", userId);
      return sendJson(res, { ok: true });
    } },
];
