/**
 * Tenant-scoped read model for durable Recovery Cases.
 *
 * Runtime writes live beside the atomic run/node transitions in
 * `packages/engine/src/persistence.ts`; this repository owns bounded reads for
 * API and UI consumers. Cases are orphan-tolerant forensic records and never
 * rely on a join to a still-existing run or workflow.
 */

import {
  db,
  recoveryCases,
  recoveryCaseTransitions,
} from "@janusly/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  RECOVERY_CASE_OPEN_STATES,
  RECOVERY_CASE_TERMINAL_STATES,
} from "@janusly/shared";

export type RecoveryCase = typeof recoveryCases.$inferSelect;
export type RecoveryCaseTransition =
  typeof recoveryCaseTransitions.$inferSelect;

export async function listRecoveryCases(
  orgId: string,
  options: {
    openOnly?: boolean;
    runId?: string;
    limit?: number;
  } = {},
): Promise<RecoveryCase[]> {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
  const filters = [eq(recoveryCases.orgId, orgId)];
  if (options.openOnly !== false) {
    filters.push(
      inArray(recoveryCases.state, [...RECOVERY_CASE_OPEN_STATES]),
    );
  }
  if (options.runId) {
    filters.push(eq(recoveryCases.runId, options.runId));
  }

  return db
    .select()
    .from(recoveryCases)
    .where(and(...filters))
    .orderBy(desc(recoveryCases.createdAt), desc(recoveryCases.id))
    .limit(limit);
}

export async function getRecoveryCase(
  orgId: string,
  caseId: string,
): Promise<RecoveryCase | null> {
  const [row] = await db
    .select()
    .from(recoveryCases)
    .where(
      and(
        eq(recoveryCases.orgId, orgId),
        eq(recoveryCases.id, caseId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listRecoveryCaseTransitions(
  orgId: string,
  caseId: string,
): Promise<RecoveryCaseTransition[]> {
  return db
    .select()
    .from(recoveryCaseTransitions)
    .where(
      and(
        eq(recoveryCaseTransitions.orgId, orgId),
        eq(recoveryCaseTransitions.caseId, caseId),
      ),
    )
    .orderBy(recoveryCaseTransitions.occurredAt)
    .limit(100);
}

export function isRecoveryCaseTerminal(state: string): boolean {
  return RECOVERY_CASE_TERMINAL_STATES.some(
    (terminal) => terminal === state,
  );
}
