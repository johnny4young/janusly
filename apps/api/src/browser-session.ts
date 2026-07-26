/** HttpOnly WorkOS browser-session cookie and CSRF boundary. */

import type http from "http";

import { signSignedToken, verifySignedToken } from "@janusly/engine/src/secrets";

import { isAllowedRequestOrigin } from "./http";

export const SSO_SESSION_PURPOSE = "sso_session" as const;
export const SESSION_COOKIE_NAME = "janusly_session";
export const SESSION_CSRF_HEADER = "x-janusly-csrf";

type BrowserSessionTokenPayload = { sessionId: string };

function parseCookies(header: string | string[] | undefined): Map<string, string> {
  const source = Array.isArray(header) ? header.join(";") : header ?? "";
  const cookies = new Map<string, string>();
  for (const part of source.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name || !value) continue;
    try { cookies.set(name, decodeURIComponent(value)); } catch { /* malformed cookie is ignored */ }
  }
  return cookies;
}

function secureCookie(): boolean {
  const explicit = process.env.JANUSLY_SESSION_COOKIE_SECURE;
  if (explicit === "true") return true;
  if (explicit === "false") return false;
  try {
    return new URL(process.env.JANUSLY_WEB_BASE_URL ?? "").protocol === "https:";
  } catch {
    return false;
  }
}

/** Mint a signed opaque browser token and its server-side expiry instant. */
export function createBrowserSessionToken(sessionId: string, ttlSeconds: number): {
  token: string;
  expiresAt: Date;
} {
  return {
    token: signSignedToken({
      purpose: SSO_SESSION_PURPOSE,
      payload: { sessionId },
      ttlSeconds,
    }),
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  };
}

/** Verify and extract the opaque session id from the request cookie. */
export function readBrowserSessionId(req: http.IncomingMessage): string | null {
  const token = parseCookies(req.headers.cookie).get(SESSION_COOKIE_NAME);
  if (!token) return null;
  try {
    const envelope = verifySignedToken<typeof SSO_SESSION_PURPOSE, BrowserSessionTokenPayload>(
      token,
      SSO_SESSION_PURPOSE,
    );
    return typeof envelope.payload.sessionId === "string" && envelope.payload.sessionId.length > 0
      ? envelope.payload.sessionId
      : null;
  } catch {
    return null;
  }
}

/** Serialize the session cookie for a successful SSO callback or org switch. */
export function sessionCookie(token: string, ttlSeconds: number): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.max(0, Math.floor(ttlSeconds))}`,
    ...(secureCookie() ? ["Secure"] : []),
  ].join("; ");
}

/** Expire the browser cookie immediately. */
export function clearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secureCookie() ? ["Secure"] : []),
  ].join("; ");
}

/**
 * Require Janusly's custom mutation header and an allowlisted browser origin.
 * This complements SameSite=Lax and applies only to cookie-authenticated writes.
 */
export function requireBrowserCsrf(req: http.IncomingMessage): void {
  const marker = req.headers[SESSION_CSRF_HEADER];
  const origin = req.headers.origin;
  if (marker !== "1" || typeof origin !== "string" || !isAllowedRequestOrigin(origin)) {
    const error = new Error("Forbidden: invalid browser session origin") as Error & { statusCode?: number };
    error.statusCode = 403;
    throw error;
  }
}
