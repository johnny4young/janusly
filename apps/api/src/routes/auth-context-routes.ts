/**
 * Provider-neutral account bootstrap surface.
 *
 * Used by the web shell after provider authentication and before any tenant
 * request. It deliberately works for identities with zero memberships and
 * treats the request's organization hint only as a selection preference.
 */

import {
  acceptInvitationForIdentity,
  createOrganizationForIdentity,
  getMembershipForOrgUser,
  getUserProfile,
  IDENTITY_MEMBERSHIP_LIMIT,
  IDENTITY_INVITATION_LIMIT,
  listPendingInvitationsForEmail,
  listOrganizationMembershipsForUser,
  updateUserProfile,
  revokeAuthSession,
  updateAuthSessionOrganization,
} from "@janusly/data";

import type { IdentityContext } from "../auth";
import {
  clearSessionCookie,
  createBrowserSessionToken,
  readBrowserSessionId,
  requireBrowserCsrf,
  sessionCookie,
} from "../browser-session";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendError, sendJson } from "../http";
import { getEffectivePermissions, resolveMemberRole } from "../permissions";
import type { Route } from "../routes";

export type SessionOrganization = {
  id: string;
  name: string;
  plan: string | null;
  role: string;
  roleBase: "viewer" | "editor" | "admin" | null;
  permissions: string[];
  usable: boolean;
  developmentFallback: boolean;
};

export type SessionContext = {
  identity: {
    userId: string;
    email: string | null;
    mode: IdentityContext["mode"];
    source: IdentityContext["source"];
  };
  profile: {
    name: string | null;
    email: string | null;
  };
  organizations: SessionOrganization[];
  invitations: Array<{
    id: string;
    organizationId: string;
    organizationName: string;
    role: string;
  }>;
  currentOrganizationId: string | null;
  selectionRequired: boolean;
  needsOrganization: boolean;
  truncated: boolean;
  invitationsTruncated: boolean;
};

/** Build the bounded organization/session projection for one verified identity. */
export async function resolveSessionContext(identity: IdentityContext): Promise<SessionContext> {
  const [rows, profile, invitationRows] = await Promise.all([
    listOrganizationMembershipsForUser(identity.userId),
    getUserProfile(identity.userId),
    identity.email ? listPendingInvitationsForEmail(identity.email) : Promise.resolve([]),
  ]);
  const truncated = rows.length > IDENTITY_MEMBERSHIP_LIMIT;
  const memberships = rows.slice(0, IDENTITY_MEMBERSHIP_LIMIT);
  const invitationsTruncated = invitationRows.length > IDENTITY_INVITATION_LIMIT;
  const invitations = invitationRows.slice(0, IDENTITY_INVITATION_LIMIT).map((invitation) => ({
    id: invitation.id,
    organizationId: invitation.orgId,
    organizationName: invitation.organizationName?.trim() || invitation.orgId,
    role: invitation.role,
  }));

  const organizations = await Promise.all(memberships.map(async (membership): Promise<SessionOrganization> => {
    const resolved = await resolveMemberRole(
      membership.orgId,
      identity.userId,
      identity.mode,
    );
    const permissions = resolved
      ? Array.from(await getEffectivePermissions(membership.orgId, resolved.name)).sort()
      : [];
    return {
      id: membership.orgId,
      name: membership.organizationName?.trim() || membership.orgId,
      plan: membership.organizationPlan,
      role: resolved?.name ?? membership.role,
      roleBase: resolved?.inheritsFrom ?? null,
      permissions,
      usable: resolved !== null,
      developmentFallback: false,
    };
  }));

  // Dev headers intentionally support arbitrary isolated org ids without a
  // persisted membership. Keep that automation contract visible and labelled;
  // no production provider receives this synthetic admin workspace.
  if (
    identity.mode === "dev-headers"
    && identity.orgHint
    && !organizations.some((organization) => organization.id === identity.orgHint)
  ) {
    const resolved = await resolveMemberRole(identity.orgHint, identity.userId, identity.mode);
    const permissions = resolved
      ? Array.from(await getEffectivePermissions(identity.orgHint, resolved.name)).sort()
      : [];
    organizations.unshift({
      id: identity.orgHint,
      name: identity.orgHint,
      plan: null,
      role: resolved?.name ?? "admin",
      roleBase: resolved?.inheritsFrom ?? "admin",
      permissions,
      usable: true,
      developmentFallback: true,
    });
  }

  const hinted = identity.orgHint
    ? organizations.find((organization) => organization.id === identity.orgHint && organization.usable)
    : undefined;
  const usableOrganizations = organizations.filter((organization) => organization.usable);
  const current = hinted ?? (usableOrganizations.length === 1 ? usableOrganizations[0] : null);

  return {
    identity: {
      userId: identity.userId,
      email: identity.email,
      mode: identity.mode,
      source: identity.source,
    },
    profile: {
      name: profile?.name ?? null,
      email: profile?.email ?? identity.email,
    },
    organizations,
    invitations,
    currentOrganizationId: current?.id ?? null,
    selectionRequired: current === null && usableOrganizations.length > 1,
    needsOrganization: usableOrganizations.length === 0,
    truncated,
    invitationsTruncated,
  };
}

function normalizedName(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (normalized.length < 2 || normalized.length > maxLength) return null;
  return normalized;
}

export const authContextRoutes: Route[] = [
  {
    method: "GET",
    match: "/auth/session",
    optionalIdentity: true,
    handler: async ({ res, identity }) => {
      if (!identity || identity.mode !== "janusly-session") {
        // This is an optional browser bootstrap probe, not a protected tenant
        // resource. A normal signed-out page load must stay console-clean.
        return sendJson(res, { authenticated: false });
      }
      return sendJson(res, {
        authenticated: true,
        userId: identity.userId,
        email: identity.email,
        organizationId: identity.orgHint,
      });
    },
  },
  {
    method: "POST",
    match: "/auth/session/logout",
    skipAuth: true,
    handler: async ({ req, res }) => {
      requireBrowserCsrf(req);
      const sessionId = readBrowserSessionId(req);
      if (sessionId) await revokeAuthSession(sessionId);
      res.setHeader("Set-Cookie", clearSessionCookie());
      return sendJson(res, { signedOut: true });
    },
  },
  {
    method: "POST",
    match: "/auth/session/organization",
    identityOnly: true,
    handler: async ({ req, res, identity }) => {
      if (!identity || identity.mode !== "janusly-session" || !identity.browserSessionId) {
        return sendError(res, "browser_session_required", "No active browser session", 401);
      }
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const organizationId = typeof body.organizationId === "string" ? body.organizationId.trim() : "";
      if (!organizationId) return sendError(res, "organization_id_required", "Organization id is required", 400);
      const membership = await getMembershipForOrgUser({ orgId: organizationId, userId: identity.userId });
      if (!membership) return sendError(res, "organization_access_denied", "You do not belong to this organization", 403);
      const updated = await updateAuthSessionOrganization({
        sessionId: identity.browserSessionId,
        userId: identity.userId,
        orgId: organizationId,
      });
      if (!updated) return sendError(res, "browser_session_update_failed", "Browser session could not be updated", 409);
      const expiresAt = updated.expiresAt instanceof Date ? updated.expiresAt : new Date(updated.expiresAt);
      const ttlSeconds = Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      const { token } = createBrowserSessionToken(updated.id, ttlSeconds);
      res.setHeader("Set-Cookie", sessionCookie(token, ttlSeconds));
      return sendJson(res, { organizationId });
    },
  },
  {
    method: "GET",
    match: "/auth/context",
    identityOnly: true,
    handler: async ({ res, identity }) => {
      if (!identity) throw new Error("identity-only route dispatched without identity");
      return sendJson(res, await resolveSessionContext(identity));
    },
  },
  {
    method: "POST",
    match: "/organizations",
    identityOnly: true,
    handler: async ({ req, res, identity }) => {
      if (!identity) throw new Error("identity-only route dispatched without identity");
      if (identity.mode === "service-token" || identity.mode === "janusly-session") {
        return sendError(res, "identity_human_required", "Use a personal account to create an organization", 403);
      }
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const organizationName = normalizedName(body.name, 80);
      if (!organizationName) {
        return sendError(res, "organization_name_invalid", "Organization name must contain 2 to 80 characters", 400);
      }
      const profileName = body.profileName === undefined || body.profileName === null || body.profileName === ""
        ? null
        : normalizedName(body.profileName, 100);
      if (body.profileName && !profileName) {
        return sendError(res, "profile_name_invalid", "Profile name must contain 2 to 100 characters", 400);
      }
      const created = await createOrganizationForIdentity({
        userId: identity.userId,
        email: identity.email,
        profileName,
        organizationName,
      });
      if (!created.ok) {
        console.error("[identity] organization creation failed", { error: created.error });
        return sendError(res, "organization_create_failed", "Organization could not be created", 500);
      }
      return sendJson(res, await resolveSessionContext({ ...identity, orgHint: created.result.id }), 201);
    },
  },
  {
    method: "POST",
    match: "/auth/invitations/accept",
    identityOnly: true,
    handler: async ({ req, res, identity }) => {
      if (!identity) throw new Error("identity-only route dispatched without identity");
      if (!identity.email || (identity.mode !== "supabase" && identity.mode !== "janusly-session")) {
        return sendError(res, "identity_email_required", "A verified account email is required", 403);
      }
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const invitationId = typeof body.invitationId === "string" ? body.invitationId.trim() : "";
      if (!invitationId) return sendError(res, "invitation_id_required", "Invitation id is required", 400);
      const accepted = await acceptInvitationForIdentity({
        invitationId,
        userId: identity.userId,
        email: identity.email,
      });
      if (!accepted.ok) {
        if (accepted.error === "invitation_not_found") {
          return sendError(res, "identity_invitation_not_found", "Invitation is no longer available", 404);
        }
        console.error("[identity] invitation acceptance failed", { error: accepted.error });
        return sendError(res, "identity_invitation_accept_failed", "Invitation could not be accepted", 500);
      }
      return sendJson(res, await resolveSessionContext({ ...identity, orgHint: accepted.result.orgId }));
    },
  },
  {
    method: "POST",
    match: "/users/me",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const name = body.name === null || body.name === "" ? null : normalizedName(body.name, 100);
      if (body.name !== null && body.name !== "" && !name) {
        return sendError(res, "profile_name_invalid", "Profile name must contain 2 to 100 characters", 400);
      }
      const updated = await updateUserProfile({
        userId: auth.userId,
        orgId: auth.orgId,
        email: null,
        name,
      });
      if (!updated.ok) {
        console.error("[identity] profile update failed", { error: updated.error });
        return sendError(res, "profile_update_failed", "Profile could not be updated", 500);
      }
      return sendJson(res, updated.result);
    },
  },
];
