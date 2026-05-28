/**
 * SSO routes — admin CRUD for `sso_connections` plus the two-step SSO
 * flow (`/auth/sso/start` + `/auth/sso/callback`) that bridges WorkOS
 * into Janusly's auth boundary.
 *
 * The flow:
 *   1. Admin attaches a WorkOS connection via `POST /org/sso/connections`.
 *   2. User visits `/auth/sso/start?orgId=X`. We mint a one-time nonce,
 *      persist it in `sso_state_nonces`, sign an HMAC-bound state token
 *      that carries `{ orgId, nonce, callbackUrl }`, and 302 to WorkOS.
 *   3. WorkOS authenticates the user against their IdP (Okta / Azure AD
 *      / Google Workspace / etc.) and 302s back to
 *      `/auth/sso/callback?code=&state=`.
 *   4. We verify the state HMAC + purpose + expiry; consume the nonce
 *      (DELETE-and-check; replays fail); verify the callback URL hasn't
 *      drifted; exchange the WorkOS code for a profile; verify
 *      `profile.connectionId === sso_connection.providerConnectionId`
 *      (defense against an org-A code being used to log in to org B);
 *      upsert the `org_members` row; issue a Janusly session token; 302
 *      back to the web with `#janusly_session=<token>` in the URL
 *      fragment so the token never lands in a server log.
 *
 * Seven audit actions:
 *   `org.sso.connection_added` / `org.sso.connection_updated` /
 *   `org.sso.connection_revoked` (admin-driven),
 *   `auth.sso.start` / `auth.sso.login` (happy path),
 *   `auth.sso.state_invalid` / `auth.sso.callback_failed` (defensive).
 *
 * Multi-tenant scope: every read and write carries
 * `eq(<table>.orgId, ...)`.
 */

import { randomBytes } from "node:crypto";

import {
  createSsoConnection,
  getSsoConnectionById,
  getSsoConnectionForOrg,
  listSsoConnections,
  revokeSsoConnection,
  updateSsoConnection,
} from "@janusly/data/src/ssoConnectionsRepo";
import { consumeSsoNonce, recordSsoNonce } from "@janusly/data/src/ssoStateNoncesRepo";
import { upsertMembership } from "@janusly/data/src/orgMembersRepo";
import { withAuditTx } from "@janusly/data/src/audit-tx";
import { signSignedToken, verifySignedToken } from "@janusly/engine/src/secrets";

import { audit } from "../audit";
import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, readJson, sendJson } from "../http";
import {
  SSO_SESSION_PURPOSE,
  SSO_STATE_PURPOSE,
  type SsoStatePayload,
} from "../auth";
import { evaluateAuthPolicy } from "../auth-policy";
import type { Route } from "../routes";
import { buildAuthorizeUrl, exchangeCode, WorkOsExchangeError } from "../workos";

const SSO_STATE_TTL_SECONDS = 10 * 60;

function getCallbackUrl(): string {
  return process.env.JANUSLY_SSO_CALLBACK_URL || "";
}

function getWebBaseUrl(): string {
  return process.env.JANUSLY_WEB_BASE_URL || "";
}

function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Soft 302 redirect — Node's `http.ServerResponse` doesn't have a
 * dedicated helper, so we set `Location` + write a tiny HTML body so
 * fetchers that don't follow redirects still see something useful.
 */
function redirect(res: import("http").ServerResponse, target: string) {
  res.statusCode = 302;
  res.setHeader("Location", target);
  res.setHeader("Cache-Control", "no-store");
  res.end(`<html><body><a href="${target.replace(/"/g, "&quot;")}">Continue</a></body></html>`);
}

export const ssoRoutes: Route[] = [
  // === Admin CRUD on sso_connections ===
  { method: "GET", match: "/org/sso/connections", role: "admin",
    handler: async ({ res, auth }) => {
      const rows = await listSsoConnections(auth.orgId);
      return sendJson(res, rows);
    } },
  { method: "POST", match: "/org/sso/connections", role: "admin",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const provider = body.provider;
      if (provider !== "workos") {
        return sendJson(res, { error: "provider must be 'workos'" }, 400);
      }
      const providerConnectionId = typeof body.providerConnectionId === "string"
        ? body.providerConnectionId.trim()
        : "";
      if (!providerConnectionId) {
        return sendJson(res, { error: "providerConnectionId is required (e.g. conn_…)" }, 400);
      }
      const enforcedSso = body.enforcedSso === true;
      // Reject re-attaching a provider that already exists for this org
      // (the unique (orgId, provider) index would error anyway; we
      // surface a clearer message + correct 409 status).
      const existing = await getSsoConnectionForOrg(auth.orgId);
      if (existing && existing.provider === "workos") {
        return sendJson(res, { error: "SSO connection already exists for this org and provider" }, 409);
      }
      const row = await createSsoConnection({
        orgId: auth.orgId,
        provider: "workos",
        providerConnectionId,
        enforcedSso,
      });
      await auditAction(auth, "org.sso.connection_added", { targetType: "sso_connection", targetId: row.id, metadata: {
        provider: row.provider,
        providerConnectionId: row.providerConnectionId,
        enforcedSso: row.enforcedSso,
      } });
      return sendJson(res, row);
    } },
  { method: "POST", match: (url) => /^\/org\/sso\/connections\/[^/]+$/.test(url), role: "admin",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/org\/sso\/connections\/([^/?]+)/);
      const id = match?.[1];
      if (!id) return sendJson(res, { error: "connection id is required" }, 400);
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const updates: { status?: "active" | "revoked"; enforcedSso?: boolean; providerConnectionId?: string } = {};
      if (body.status === "active" || body.status === "revoked") updates.status = body.status;
      if (typeof body.enforcedSso === "boolean") updates.enforcedSso = body.enforcedSso;
      if (body.providerConnectionId !== undefined) {
        const providerConnectionId = typeof body.providerConnectionId === "string"
          ? body.providerConnectionId.trim()
          : "";
        if (!providerConnectionId) {
          return sendJson(res, { error: "providerConnectionId must be a non-empty string" }, 400);
        }
        updates.providerConnectionId = providerConnectionId;
      }
      if (updates.status === undefined && updates.enforcedSso === undefined && updates.providerConnectionId === undefined) {
        return sendJson(res, { error: "no updatable fields provided" }, 400);
      }
      const existing = await getSsoConnectionById({ id, orgId: auth.orgId });
      if (!existing) return sendJson(res, { error: "SSO connection not found" }, 404);
      const updated = await updateSsoConnection({ id, orgId: auth.orgId, ...updates });
      await auditAction(auth, "org.sso.connection_updated", { targetType: "sso_connection", targetId: id, metadata: updates });
      return sendJson(res, updated);
    } },
  { method: "DELETE", match: (url) => /^\/org\/sso\/connections\/[^/]+$/.test(url), role: "admin",
    handler: async ({ req, res, auth }) => {
      const match = (req.url ?? "").match(/^\/org\/sso\/connections\/([^/?]+)/);
      const id = match?.[1];
      if (!id) return sendJson(res, { error: "connection id is required" }, 400);
      const existing = await getSsoConnectionById({ id, orgId: auth.orgId });
      if (!existing) return sendJson(res, { error: "SSO connection not found" }, 404);
      await revokeSsoConnection({ id, orgId: auth.orgId });
      await auditAction(auth, "org.sso.connection_revoked", { targetType: "sso_connection", targetId: id });
      return sendJson(res, { ok: true });
    } },

  // === SSO flow ===
  { method: "GET", match: (url) => url === "/auth/sso/start" || url.startsWith("/auth/sso/start?"),
    skipAuth: true,
    handler: async ({ req, res }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const orgId = url.searchParams.get("orgId");
      if (!orgId) return sendJson(res, { error: "orgId is required" }, 400);
      const callbackUrl = getCallbackUrl();
      if (!callbackUrl) return sendJson(res, { error: "SSO is not configured (missing JANUSLY_SSO_CALLBACK_URL)" }, 500);
      const sso = await getSsoConnectionForOrg(orgId);
      if (!sso || sso.status !== "active") {
        return sendJson(res, { error: "no active SSO connection for this org" }, 404);
      }
      const nonce = newNonce();
      const expiresAt = new Date(Date.now() + SSO_STATE_TTL_SECONDS * 1000);
      await recordSsoNonce({ orgId, nonce, expiresAt });
      const state = signSignedToken<typeof SSO_STATE_PURPOSE, SsoStatePayload>({
        purpose: SSO_STATE_PURPOSE,
        payload: { orgId, nonce, callbackUrl },
        ttlSeconds: SSO_STATE_TTL_SECONDS,
      });
      const authorizeUrl = buildAuthorizeUrl({
        connectionId: sso.providerConnectionId,
        redirectUri: callbackUrl,
        state,
      });
      // Audit BEFORE the redirect so a server-side log of the start
      // exists even if the user never reaches WorkOS (network blip,
      // user closes the tab).
      await audit(orgId, "sso", "auth.sso.start", "sso_connection", sso.id, {
        provider: sso.provider,
        connectionId: sso.providerConnectionId,
      });
      return redirect(res, authorizeUrl);
    } },
  { method: "GET", match: (url) => url.startsWith("/auth/sso/callback"),
    skipAuth: true,
    handler: async ({ req, res }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const code = url.searchParams.get("code");
      const stateToken = url.searchParams.get("state");
      const callbackUrl = getCallbackUrl();
      const webBaseUrl = getWebBaseUrl();
      if (!callbackUrl || !webBaseUrl) {
        return sendJson(res, { error: "SSO is not configured" }, 500);
      }
      if (!code || !stateToken) {
        return sendJson(res, { error: "code and state are required" }, 400);
      }
      let statePayload: SsoStatePayload;
      try {
        const envelope = verifySignedToken<typeof SSO_STATE_PURPOSE, SsoStatePayload>(
          stateToken,
          SSO_STATE_PURPOSE,
        );
        statePayload = envelope.payload;
      } catch {
        await audit("default", "sso", "auth.sso.state_invalid", "sso_state", "", {
          reason: "invalid_signature_or_expiry",
        });
        return sendJson(res, { error: "invalid state" }, 400);
      }

      const { orgId, nonce, callbackUrl: stateCallbackUrl } = statePayload;
      if (stateCallbackUrl !== callbackUrl) {
        await audit(orgId, "sso", "auth.sso.state_invalid", "sso_state", "", {
          reason: "callback_url_mismatch",
        });
        return sendJson(res, { error: "invalid state" }, 400);
      }

      const consumed = await consumeSsoNonce({ orgId, nonce });
      if (!consumed) {
        await audit(orgId, "sso", "auth.sso.state_invalid", "sso_state", "", {
          reason: "nonce_replayed_or_expired",
        });
        return sendJson(res, { error: "invalid state" }, 400);
      }

      const sso = await getSsoConnectionForOrg(orgId);
      if (!sso || sso.status !== "active") {
        await audit(orgId, "sso", "auth.sso.callback_failed", "sso_connection", "", {
          reason: "connection_missing",
        });
        return sendJson(res, { error: "no active SSO connection for this org" }, 404);
      }

      let profile;
      try {
        profile = await exchangeCode({ code, redirectUri: callbackUrl });
      } catch (err) {
        const reason = err instanceof WorkOsExchangeError ? `workos_${err.statusCode}` : "exchange_failed";
        await audit(orgId, "sso", "auth.sso.callback_failed", "sso_connection", sso.id, {
          reason,
        });
        return sendJson(res, { error: "SSO exchange failed" }, 400);
      }

      if (profile.connectionId !== sso.providerConnectionId) {
        // Defense in depth: the WorkOS code was issued for a different
        // connection than the org's. Refuse to JIT-provision.
        await audit(orgId, "sso", "auth.sso.callback_failed", "sso_connection", sso.id, {
          reason: "connection_id_mismatch",
          expectedConnectionId: sso.providerConnectionId,
          profileConnectionId: profile.connectionId,
        });
        return sendJson(res, { error: "SSO connection mismatch" }, 400);
      }

      // Policy gate BEFORE JIT-provisioning. An admin's
      // `auth.allowedEmailDomains: "acme.com"` policy must fire here
      // even though the user just authenticated via the IdP — otherwise
      // an Okta directory exposing `@partner.com` users silently
      // bypasses the org's domain policy. The evaluator emits its own
      // `auth.policy.rejected` audit row; we ALSO emit
      // `auth.sso.callback_failed` so the SSO audit trail stays
      // chronologically complete.
      const policyDecision = await evaluateAuthPolicy({
        orgId,
        userId: profile.id,
        mode: "janusly-session",
        email: profile.email,
        ssoConnection: sso,
      });
      if (!policyDecision.allowed) {
        await audit(orgId, profile.id, "auth.sso.callback_failed", "sso_connection", sso.id, {
          reason: "policy_rejected",
          policyKey: policyDecision.policyKey,
        });
        return sendJson(
          res,
          { error: "policy_violation", policyKey: policyDecision.policyKey },
          403,
        );
      }

      // Atomic membership + login audit. Failure here rolls back the
      // org_members upsert so we never leave a member without their
      // login audit trail (the breakage mode is a Postgres blip
      // between the two writes). Failure surfaces as a 500 to the
      // caller; WorkOS' SSO callback is one-shot per state nonce
      // already, so the user retries by re-initiating SSO.
      const txResult = await withAuditTx(async (tx, txAudit) => {
        await upsertMembership({
          orgId,
          userId: profile.id,
          email: profile.email,
          role: "viewer",
        }, tx);
        await txAudit({
          orgId,
          userId: profile.id,
          action: "auth.sso.login",
          targetType: "sso_connection",
          targetId: sso.id,
          metadata: {
            via: "workos",
            connectionId: sso.providerConnectionId,
            email: profile.email,
          },
        });
      });
      if (!txResult.ok) {
        await audit(orgId, profile.id, "auth.sso.callback_failed", "sso_connection", sso.id, {
          reason: "membership_persist_failed",
          detail: txResult.error,
        });
        return sendJson(res, { error: "membership_persist_failed" }, 500);
      }

      const sessionToken = signSignedToken({
        purpose: SSO_SESSION_PURPOSE,
        payload: { orgId, userId: profile.id, email: profile.email },
        ttlSeconds: policyDecision.sessionTtlSeconds,
      });

      const redirectTarget = `${webBaseUrl.replace(/\/$/, "")}/auth/sso/complete#janusly_session=${encodeURIComponent(sessionToken)}`;
      return redirect(res, redirectTarget);
    } },
];
