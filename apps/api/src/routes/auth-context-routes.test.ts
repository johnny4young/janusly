import { Readable } from "node:stream";
import type http from "node:http";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listOrganizationMembershipsForUser = vi.fn();
const getUserProfile = vi.fn();
const listPendingInvitationsForEmail = vi.fn();
const resolveMemberRole = vi.fn();
const getEffectivePermissions = vi.fn();
const createOrganizationForIdentity = vi.fn();
const acceptInvitationForIdentity = vi.fn();
const updateUserProfile = vi.fn();
const getMembershipForOrgUser = vi.fn();
const revokeAuthSession = vi.fn();
const updateAuthSessionOrganization = vi.fn();
const requireBrowserCsrf = vi.fn();
const readBrowserSessionId = vi.fn();

vi.mock("@janusly/data", () => ({
  IDENTITY_MEMBERSHIP_LIMIT: 200,
  IDENTITY_INVITATION_LIMIT: 50,
  listOrganizationMembershipsForUser: (...args: unknown[]) => listOrganizationMembershipsForUser(...args),
  getUserProfile: (...args: unknown[]) => getUserProfile(...args),
  listPendingInvitationsForEmail: (...args: unknown[]) => listPendingInvitationsForEmail(...args),
  createOrganizationForIdentity: (...args: unknown[]) => createOrganizationForIdentity(...args),
  acceptInvitationForIdentity: (...args: unknown[]) => acceptInvitationForIdentity(...args),
  updateUserProfile: (...args: unknown[]) => updateUserProfile(...args),
  getMembershipForOrgUser: (...args: unknown[]) => getMembershipForOrgUser(...args),
  revokeAuthSession: (...args: unknown[]) => revokeAuthSession(...args),
  updateAuthSessionOrganization: (...args: unknown[]) => updateAuthSessionOrganization(...args),
}));

vi.mock("../browser-session", () => ({
  requireBrowserCsrf: (...args: unknown[]) => requireBrowserCsrf(...args),
  readBrowserSessionId: (...args: unknown[]) => readBrowserSessionId(...args),
  clearSessionCookie: () => "janusly_session=; Path=/; HttpOnly; Max-Age=0",
  createBrowserSessionToken: () => ({ token: "opaque-token", expiresAt: new Date() }),
  sessionCookie: (_token: string, ttlSeconds: number) => `janusly_session=opaque-token; Max-Age=${ttlSeconds}`,
}));

vi.mock("../permissions", () => ({
  resolveMemberRole: (...args: unknown[]) => resolveMemberRole(...args),
  getEffectivePermissions: (...args: unknown[]) => getEffectivePermissions(...args),
}));

import type { IdentityContext } from "../auth";
import { authContextRoutes, resolveSessionContext } from "./auth-context-routes";

const SUPABASE_IDENTITY: IdentityContext = {
  userId: "user-1",
  email: "user@example.com",
  mode: "supabase",
  source: "web",
  orgHint: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  listOrganizationMembershipsForUser.mockResolvedValue([]);
  getUserProfile.mockResolvedValue(null);
  listPendingInvitationsForEmail.mockResolvedValue([]);
  resolveMemberRole.mockResolvedValue({ name: "viewer", inheritsFrom: "viewer" });
  getEffectivePermissions.mockResolvedValue(new Set(["workflows.read", "runs.read"]));
  createOrganizationForIdentity.mockResolvedValue({ ok: true, result: { id: "org-new" } });
  acceptInvitationForIdentity.mockResolvedValue({ ok: true, result: { orgId: "org-a" } });
  updateUserProfile.mockResolvedValue({ ok: true, result: { id: "user-1", name: "Ada" } });
  getMembershipForOrgUser.mockResolvedValue(null);
  revokeAuthSession.mockResolvedValue(true);
  updateAuthSessionOrganization.mockResolvedValue(null);
  readBrowserSessionId.mockReturnValue(null);
});

describe("identity lifecycle route handlers", () => {
  it("returns a console-clean anonymous result when no browser session exists", async () => {
    const response = await invokeRoute("GET", "/auth/session", {});

    expect(response.status).toBe(200);
    expect(response.json).toEqual({ authenticated: false });
  });

  it("returns the active browser-session identity without exposing session material", async () => {
    const response = await invokeRoute("GET", "/auth/session", {
      identity: {
        userId: "user-sso",
        email: "sso@example.com",
        mode: "janusly-session",
        source: "web",
        orgHint: "org-sso",
        browserSessionId: "session-secret",
      },
    });

    expect(response.status).toBe(200);
    expect(response.json).toEqual({
      authenticated: true,
      userId: "user-sso",
      email: "sso@example.com",
      organizationId: "org-sso",
    });
  });

  it("creates the first organization for a provider-backed personal identity", async () => {
    const response = await invokeRoute("POST", "/organizations", {
      identity: SUPABASE_IDENTITY,
      body: { name: "  Acme   Operations ", profileName: " Ada Operator " },
    });

    expect(response.status).toBe(201);
    expect(createOrganizationForIdentity).toHaveBeenCalledWith({
      userId: "user-1",
      email: "user@example.com",
      profileName: "Ada Operator",
      organizationName: "Acme Operations",
    });
  });

  it("accepts only the invitation belonging to the verified identity", async () => {
    const response = await invokeRoute("POST", "/auth/invitations/accept", {
      identity: SUPABASE_IDENTITY,
      body: { invitationId: "invite-1" },
    });

    expect(response.status).toBe(200);
    expect(acceptInvitationForIdentity).toHaveBeenCalledWith({
      invitationId: "invite-1",
      userId: "user-1",
      email: "user@example.com",
    });
  });

  it("revokes the server row and clears the cookie on logout", async () => {
    readBrowserSessionId.mockReturnValueOnce("session-1");
    const response = await invokeRoute("POST", "/auth/session/logout", {});

    expect(requireBrowserCsrf).toHaveBeenCalledTimes(1);
    expect(revokeAuthSession).toHaveBeenCalledWith("session-1");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.json).toEqual({ signedOut: true });
  });

  it("proves membership before rotating a browser session organization", async () => {
    const identity: IdentityContext = {
      userId: "user-1",
      email: "user@example.com",
      mode: "janusly-session",
      source: "web",
      orgHint: "org-a",
      browserSessionId: "session-1",
    };
    getMembershipForOrgUser.mockResolvedValueOnce({ id: "member-1" });
    updateAuthSessionOrganization.mockResolvedValueOnce({
      id: "session-1",
      userId: "user-1",
      email: "user@example.com",
      orgId: "org-b",
      expiresAt: new Date(Date.now() + 60_000),
      revokedAt: null,
    });

    const response = await invokeRoute("POST", "/auth/session/organization", {
      identity,
      body: { organizationId: "org-b" },
    });

    expect(response.status).toBe(200);
    expect(getMembershipForOrgUser).toHaveBeenCalledWith({ orgId: "org-b", userId: "user-1" });
    expect(updateAuthSessionOrganization).toHaveBeenCalledWith({
      sessionId: "session-1",
      userId: "user-1",
      orgId: "org-b",
    });
    expect(response.headers.get("set-cookie")).toContain("janusly_session=opaque-token");
  });

  it("rejects browser organization rotation without membership", async () => {
    const response = await invokeRoute("POST", "/auth/session/organization", {
      identity: {
        userId: "user-1",
        email: "user@example.com",
        mode: "janusly-session",
        source: "web",
        orgHint: "org-a",
        browserSessionId: "session-1",
      },
      body: { organizationId: "org-b" },
    });

    expect(response.status).toBe(403);
    expect(response.json).toMatchObject({ code: "organization_access_denied" });
    expect(updateAuthSessionOrganization).not.toHaveBeenCalled();
  });
});

async function invokeRoute(
  method: "GET" | "POST",
  path: string,
  options: { identity?: IdentityContext; body?: unknown },
): Promise<{ status: number; json: unknown; headers: Map<string, string> }> {
  const route = authContextRoutes.find((candidate) => candidate.method === method && candidate.match === path);
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  const request = Readable.from(options.body === undefined ? [] : [JSON.stringify(options.body)]) as unknown as http.IncomingMessage;
  Object.assign(request, {
    method,
    url: path,
    headers: options.body === undefined ? {} : { "content-type": "application/json" },
  });
  const headers = new Map<string, string>();
  let status = 200;
  let raw = "";
  const response = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
    },
    writeHead(nextStatus: number, nextHeaders?: http.OutgoingHttpHeaders) {
      status = nextStatus;
      for (const [name, value] of Object.entries(nextHeaders ?? {})) {
        if (value !== undefined) headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(", ") : String(value));
      }
      return this;
    },
    end(chunk?: string | Buffer) {
      raw = chunk?.toString() ?? "";
      return this;
    },
  } as unknown as http.ServerResponse;

  await route.handler({
    req: request,
    res: response,
    auth: {
      orgId: options.identity?.orgHint ?? "org-a",
      userId: options.identity?.userId ?? "user-1",
      mode: options.identity?.mode ?? "dev-headers",
      source: options.identity?.source ?? "dev",
    },
    identity: options.identity ?? null,
  });

  return { status, json: raw ? JSON.parse(raw) : null, headers };
}

describe("resolveSessionContext", () => {
  it("represents a legitimate identity with zero memberships", async () => {
    await expect(resolveSessionContext(SUPABASE_IDENTITY)).resolves.toEqual({
      identity: {
        userId: "user-1",
        email: "user@example.com",
        mode: "supabase",
        source: "web",
      },
      profile: { name: null, email: "user@example.com" },
      organizations: [],
      invitations: [],
      currentOrganizationId: null,
      selectionRequired: false,
      needsOrganization: true,
      truncated: false,
      invitationsTruncated: false,
    });
  });

  it("returns the global profile and bounded pending invitations", async () => {
    getUserProfile.mockResolvedValueOnce({
      id: "user-1",
      email: "profile@example.com",
      name: "Ada Operator",
      createdAt: null,
      updatedAt: null,
    });
    listPendingInvitationsForEmail.mockResolvedValueOnce([{
      id: "invite-1",
      orgId: "org-a",
      email: "user@example.com",
      role: "editor",
      invitedBy: "admin-1",
      status: "pending",
      acceptedAt: null,
      createdAt: null,
      organizationName: "Acme Operations",
    }]);

    const result = await resolveSessionContext(SUPABASE_IDENTITY);

    expect(result.profile).toEqual({ name: "Ada Operator", email: "profile@example.com" });
    expect(result.invitations).toEqual([{
      id: "invite-1",
      organizationId: "org-a",
      organizationName: "Acme Operations",
      role: "editor",
    }]);
  });

  it("selects the only membership and returns its actual permissions", async () => {
    listOrganizationMembershipsForUser.mockResolvedValueOnce([{
      id: "member-1",
      orgId: "org-a",
      userId: "user-1",
      email: "user@example.com",
      role: "viewer",
      invitedBy: null,
      createdAt: null,
      organizationName: "Acme Operations",
      organizationPlan: "team",
    }]);

    const result = await resolveSessionContext(SUPABASE_IDENTITY);

    expect(result.currentOrganizationId).toBe("org-a");
    expect(result.selectionRequired).toBe(false);
    expect(result.needsOrganization).toBe(false);
    expect(result.organizations).toEqual([{
      id: "org-a",
      name: "Acme Operations",
      plan: "team",
      role: "viewer",
      roleBase: "viewer",
      permissions: ["runs.read", "workflows.read"],
      usable: true,
      developmentFallback: false,
    }]);
  });

  it("requires an explicit choice for multiple memberships without a valid hint", async () => {
    listOrganizationMembershipsForUser.mockResolvedValueOnce([
      {
        id: "member-1", orgId: "org-a", userId: "user-1", email: null, role: "viewer",
        invitedBy: null, createdAt: null, organizationName: "Alpha", organizationPlan: "free",
      },
      {
        id: "member-2", orgId: "org-b", userId: "user-1", email: null, role: "viewer",
        invitedBy: null, createdAt: null, organizationName: "Beta", organizationPlan: "team",
      },
    ]);

    const result = await resolveSessionContext({ ...SUPABASE_IDENTITY, orgHint: "unknown" });

    expect(result.currentOrganizationId).toBeNull();
    expect(result.selectionRequired).toBe(true);
    expect(result.needsOrganization).toBe(false);
  });

  it("labels the synthetic dev workspace instead of pretending it is persisted", async () => {
    resolveMemberRole.mockResolvedValueOnce({ name: "admin", inheritsFrom: "admin" });
    getEffectivePermissions.mockResolvedValueOnce(new Set(["members.write", "workflows.read"]));

    const result = await resolveSessionContext({
      userId: "dev-user",
      email: null,
      mode: "dev-headers",
      source: "dev",
      orgHint: "default",
    });

    expect(result.currentOrganizationId).toBe("default");
    expect(result.organizations[0]).toMatchObject({
      id: "default",
      role: "admin",
      developmentFallback: true,
      permissions: ["members.write", "workflows.read"],
    });
  });
});
