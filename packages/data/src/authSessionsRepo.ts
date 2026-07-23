/**
 * Revocable WorkOS browser sessions.
 *
 * The browser cookie contains only a signed session id. Every provider
 * extraction resolves that id through this repo and rejects revoked or
 * expired rows before tenant membership resolution.
 *
 * Used by `apps/api/src/auth.ts` and `apps/api/src/routes/sso-routes.ts`.
 */

import { and, eq, gt, isNull } from "drizzle-orm";
import { authSessions, db } from "@janusly/db";

import type { DbOrTx } from "./audit-tx";

export type AuthSessionRow = {
  id: string;
  userId: string;
  email: string;
  orgId: string;
  expiresAt: Date | string;
  revokedAt: Date | string | null;
};

function mapRow(row: typeof authSessions.$inferSelect): AuthSessionRow {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    orgId: row.orgId,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

/** Insert one browser session inside the caller's transaction when supplied. */
export async function createAuthSession(input: {
  userId: string;
  email: string;
  orgId: string;
  expiresAt: Date;
}, dbOrTx: DbOrTx = db): Promise<AuthSessionRow> {
  const [row] = await dbOrTx.insert(authSessions).values({
    id: crypto.randomUUID(),
    userId: input.userId,
    email: input.email.trim().toLowerCase(),
    orgId: input.orgId,
    expiresAt: input.expiresAt,
  }).returning();
  if (!row) throw new Error("auth session vanished after insert");
  return mapRow(row);
}

/** Resolve one active, unexpired session id. */
export async function getActiveAuthSession(sessionId: string): Promise<AuthSessionRow | null> {
  const [row] = await db.select().from(authSessions).where(and(
    eq(authSessions.id, sessionId),
    isNull(authSessions.revokedAt),
    gt(authSessions.expiresAt, new Date()),
  ));
  return row ? mapRow(row) : null;
}

/** Revoke a session immediately; idempotent for logout retries. */
export async function revokeAuthSession(sessionId: string): Promise<boolean> {
  const rows = await db.update(authSessions)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(authSessions.id, sessionId), isNull(authSessions.revokedAt)))
    .returning({ id: authSessions.id });
  return rows.length > 0;
}

/** Move one active session to another organization after membership proof. */
export async function updateAuthSessionOrganization(input: {
  sessionId: string;
  userId: string;
  orgId: string;
}): Promise<AuthSessionRow | null> {
  const [row] = await db.update(authSessions)
    .set({ orgId: input.orgId, updatedAt: new Date() })
    .where(and(
      eq(authSessions.id, input.sessionId),
      eq(authSessions.userId, input.userId),
      isNull(authSessions.revokedAt),
      gt(authSessions.expiresAt, new Date()),
    ))
    .returning();
  return row ? mapRow(row) : null;
}
