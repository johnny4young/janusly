/**
 * Bounded cleanup for global browser-authentication state.
 *
 * Used by `packages/engine/src/identity-retention-scheduler.ts`.
 * Browser sessions and one-time SSO nonces are operational state rather than
 * audit history, so expired rows are removed without following tenant data.
 */

import { authSessions, db, ssoStateNonces } from "@janusly/db";
import { sql } from "drizzle-orm";

export const DEFAULT_IDENTITY_RETENTION_BATCH_SIZE = 10_000;
export const DEFAULT_IDENTITY_RETENTION_MAX_BATCHES = 1_000;

export type PruneIdentityStateInput = {
  /** Expired or revoked browser sessions older than this instant are eligible. */
  sessionOlderThan: Date;
  /** One-time SSO nonces expired before this instant are eligible. */
  nonceExpiredBefore?: Date;
  batchSize?: number;
  maxBatches?: number;
};

export type PruneIdentityStateResult = {
  sessionsDeleted: number;
  noncesDeleted: number;
  sessionCutoffAt: string;
  nonceCutoffAt: string;
  runtimeMs: number;
  cappedByMaxBatches: boolean;
};

async function runBatchedDelete(
  batchSize: number,
  maxBatches: number,
  execute: () => Promise<number>,
): Promise<{ rowsDeleted: number; capped: boolean }> {
  let rowsDeleted = 0;
  for (let index = 0; index < maxBatches; index += 1) {
    const deleted = await execute();
    rowsDeleted += deleted;
    if (deleted < batchSize) return { rowsDeleted, capped: false };
  }
  return { rowsDeleted, capped: true };
}
/** Remove stale browser sessions and expired one-time SSO state nonces. */
export async function pruneIdentityState(
  input: PruneIdentityStateInput,
): Promise<PruneIdentityStateResult> {
  const batchSize = input.batchSize ?? DEFAULT_IDENTITY_RETENTION_BATCH_SIZE;
  const maxBatches = input.maxBatches ?? DEFAULT_IDENTITY_RETENTION_MAX_BATCHES;
  const sessionCutoffAt = input.sessionOlderThan.toISOString();
  const nonceCutoffAt = (input.nonceExpiredBefore ?? new Date()).toISOString();
  const startedAt = Date.now();

  const sessions = await runBatchedDelete(batchSize, maxBatches, async () => {
    const rows = await db.execute<{ id: string }>(sql`
      DELETE FROM ${authSessions}
      WHERE ${authSessions.id} IN (
        SELECT ${authSessions.id} FROM ${authSessions}
        WHERE (${authSessions.expiresAt} < ${sessionCutoffAt}::timestamptz)
          OR (${authSessions.revokedAt} IS NOT NULL
            AND ${authSessions.revokedAt} < ${sessionCutoffAt}::timestamptz)
        LIMIT ${batchSize}
      )
      RETURNING ${authSessions.id}
    `);
    return rows.length;
  });

  const nonces = await runBatchedDelete(batchSize, maxBatches, async () => {
    const rows = await db.execute<{ id: string }>(sql`
      DELETE FROM ${ssoStateNonces}
      WHERE ${ssoStateNonces.id} IN (
        SELECT ${ssoStateNonces.id} FROM ${ssoStateNonces}
        WHERE ${ssoStateNonces.expiresAt} < ${nonceCutoffAt}::timestamptz
        LIMIT ${batchSize}
      )
      RETURNING ${ssoStateNonces.id}
    `);
    return rows.length;
  });

  return {
    sessionsDeleted: sessions.rowsDeleted,
    noncesDeleted: nonces.rowsDeleted,
    sessionCutoffAt,
    nonceCutoffAt,
    runtimeMs: Date.now() - startedAt,
    cappedByMaxBatches: sessions.capped || nonces.capped,
  };
}
