/**
 * One-time-use nonces for SSO state tokens. Defends against
 * replay-within-TTL attacks on the SSO callback: an attacker who captures
 * a callback URL during the 10-minute window can't re-issue a session by
 * replaying the same `state` because the nonce gets DELETE'd on first
 * consume.
 *
 * The HMAC signature on the state token (issued by `signSignedToken`)
 * binds `(orgId, nonce, callbackUrl, expiresAt)`; this table provides
 * the orthogonal "this nonce has not been used yet" check. Both gates
 * must pass for the callback to proceed.
 *
 * Multi-tenant scope: every read and write carries
 * `eq(ssoStateNonces.orgId, orgId)`. Unique `(orgId, nonce)` makes the
 * DELETE-and-check race-safe — concurrent consumers race on the DELETE;
 * whichever wins gets `true`, the loser gets `false`.
 *
 * Used by:
 * - `apps/api/src/routes/sso-routes.ts` (`/auth/sso/start` records,
 *   `/auth/sso/callback` consumes).
 */

import { and, eq, gt } from "drizzle-orm";
import { db, ssoStateNonces } from "@janusly/db";

export type SsoNonceRow = {
  id: string;
  orgId: string;
  nonce: string;
  expiresAt: Date | string;
  createdAt: Date | string | null;
};

/**
 * Record a nonce for an org, scoped to expire at `expiresAt`. Caller
 * supplies the nonce string (typically a 32-byte hex from
 * `crypto.randomBytes(16).toString("hex")`).
 */
export async function recordSsoNonce(input: {
  orgId: string;
  nonce: string;
  expiresAt: Date;
}): Promise<void> {
  await db.insert(ssoStateNonces).values({
    id: crypto.randomUUID(),
    orgId: input.orgId,
    nonce: input.nonce,
    expiresAt: input.expiresAt,
  });
}

/**
 * Atomically consume a nonce: returns `true` if a matching row existed
 * AND was not expired, `false` otherwise. Idempotent under concurrent
 * consumers — the underlying DELETE is atomic; one caller wins, the
 * rest see no row and return false.
 *
 * Pruning is implicit: a consumed nonce is gone, and expired nonces
 * stay until a future sweep ticket adds one. The verifier's
 * `expiresAt > now` check keeps stale rows harmless either way.
 */
export async function consumeSsoNonce(
  input: { orgId: string; nonce: string },
): Promise<boolean> {
  const rows = await db
    .delete(ssoStateNonces)
    .where(
      and(
        eq(ssoStateNonces.orgId, input.orgId),
        eq(ssoStateNonces.nonce, input.nonce),
        gt(ssoStateNonces.expiresAt, new Date()),
      ),
    )
    .returning({ id: ssoStateNonces.id });
  return rows.length > 0;
}

// Multi-tenant invariant: tenant-scoped reads and writes keep orgId in the predicate; document system/global exceptions - see AGENTS.md "AuthContext is Janusly-resolved".
