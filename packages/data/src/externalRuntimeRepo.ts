/**
 * Durable read-only projections for externally owned workflow runtimes.
 *
 * Ordinary reads and configuration writes are tenant-scoped. The callback
 * lookup by opaque connection id is the sole cross-tenant read and callers
 * must verify the exact raw-body HMAC before invoking `recordExternalRuntimeEvent`.
 *
 * External lifecycle rows are intentionally orphan-tolerant: deleting a
 * connection prevents future ingestion but keeps signed receipts and projected
 * history available for forensic inspection.
 */

import { and, asc, desc, eq, lt, sql } from "drizzle-orm";

import {
  db,
  externalRecoveryCases,
  externalRunSteps,
  externalRuns,
  externalRuntimeConnections,
  externalRuntimeEvents,
  externalWorkflows,
} from "@janusly/db";
import type {
  ExternalEvidencePointer,
  ExternalRunEvent,
  ExternalRuntimeEvent,
  ExternalStepEvent,
} from "@janusly/shared";
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import { safePersistPayload } from "@janusly/shared/src/safe-persist";

export const EXTERNAL_RUNTIME_CONNECTION_NAME_MAX = 120;
export const EXTERNAL_RUNTIME_KEY_MAX = 120;
export const EXTERNAL_RUNTIME_CREDENTIAL_NAME_MAX = 200;
export const EXTERNAL_RUNTIME_PAYLOAD_MAX_BYTES = 64_000;

export type ExternalRuntimeConnection = typeof externalRuntimeConnections.$inferSelect;
export type ExternalRuntimeEventReceipt = typeof externalRuntimeEvents.$inferSelect;
export type ExternalWorkflow = typeof externalWorkflows.$inferSelect;
export type ExternalRun = typeof externalRuns.$inferSelect;
export type ExternalRunStep = typeof externalRunSteps.$inferSelect;
export type ExternalRecoveryCase = typeof externalRecoveryCases.$inferSelect;

export type ExternalRuntimeProjectionState = "applied" | "stale";

export type RecordExternalRuntimeEventResult =
  | { kind: "connection_not_found" }
  | {
      kind: "duplicate";
      receipt: ExternalRuntimeEventReceipt;
    }
  | {
      kind: ExternalRuntimeProjectionState;
      receipt: ExternalRuntimeEventReceipt;
    };

function normalizeConnectionFields(input: {
  name: string;
  runtimeKey: string;
  signingCredentialName: string;
}) {
  const normalized = {
    name: input.name.trim(),
    runtimeKey: input.runtimeKey.trim(),
    signingCredentialName: input.signingCredentialName.trim(),
  };
  if (
    normalized.name.length === 0
    || normalized.name.length > EXTERNAL_RUNTIME_CONNECTION_NAME_MAX
    || normalized.runtimeKey.length === 0
    || normalized.runtimeKey.length > EXTERNAL_RUNTIME_KEY_MAX
    || normalized.signingCredentialName.length === 0
    || normalized.signingCredentialName.length > EXTERNAL_RUNTIME_CREDENTIAL_NAME_MAX
  ) {
    throw new Error("external_runtime_invalid_connection_fields");
  }
  return normalized;
}

function scrubExternalValue(value: unknown): unknown {
  if (typeof value === "string") return scrubSecretShapes(value);
  if (Array.isArray(value)) return value.map(scrubExternalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => [key, scrubExternalValue(item)]),
    );
  }
  return value;
}

function safeExternalPayload(value: unknown): unknown {
  return safePersistPayload(scrubExternalValue(value), {
    maxBytes: EXTERNAL_RUNTIME_PAYLOAD_MAX_BYTES,
  });
}

function safeEvidence(evidence: readonly ExternalEvidencePointer[]): unknown {
  return safeExternalPayload(evidence);
}

function scrubExternalString(value: string): string {
  return scrubSecretShapes(value);
}

function assertSafeEventIdentities(event: ExternalRuntimeEvent): void {
  const identities = [
    event.id,
    event.source,
    event.data.externalWorkflowId,
    "externalRunId" in event.data ? event.data.externalRunId : null,
    "externalStepId" in event.data ? event.data.externalStepId : null,
  ].filter((value): value is string => typeof value === "string");
  if (identities.some((value) => scrubExternalString(value) !== value)) {
    throw new Error("external_runtime_sensitive_identity");
  }
}

/** List configured external-runtime connections for one organization. */
export async function listExternalRuntimeConnections(
  orgId: string,
): Promise<ExternalRuntimeConnection[]> {
  return db.select().from(externalRuntimeConnections)
    .where(eq(externalRuntimeConnections.orgId, orgId))
    .orderBy(asc(externalRuntimeConnections.name))
    .limit(100);
}

/** Get one connection inside an organization. */
export async function getExternalRuntimeConnection(
  orgId: string,
  id: string,
): Promise<ExternalRuntimeConnection | null> {
  const rows = await db.select().from(externalRuntimeConnections).where(and(
    eq(externalRuntimeConnections.orgId, orgId),
    eq(externalRuntimeConnections.id, id),
  )).limit(1);
  return rows[0] ?? null;
}

/**
 * Resolve an opaque public callback id before tenant authentication exists.
 * The caller must verify the associated credential before accepting payloads.
 */
export async function getExternalRuntimeConnectionForCallback(
  id: string,
): Promise<ExternalRuntimeConnection | null> {
  const rows = await db.select().from(externalRuntimeConnections)
    .where(eq(externalRuntimeConnections.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Create one external-runtime connection after route-level credential validation. */
export async function createExternalRuntimeConnection(input: {
  orgId: string;
  name: string;
  runtimeKey: string;
  signingCredentialName: string;
  enabled: boolean;
  createdBy: string;
}): Promise<ExternalRuntimeConnection> {
  const now = new Date();
  const rows = await db.insert(externalRuntimeConnections).values({
    id: crypto.randomUUID(),
    orgId: input.orgId,
    ...normalizeConnectionFields(input),
    enabled: input.enabled,
    createdBy: input.createdBy,
    createdAt: now,
    updatedAt: now,
  }).returning();
  if (!rows[0]) throw new Error("external_runtime_create_failed");
  return rows[0];
}

/** Update mutable external-runtime connection configuration. */
export async function updateExternalRuntimeConnection(input: {
  orgId: string;
  id: string;
  name: string;
  runtimeKey: string;
  signingCredentialName: string;
  enabled: boolean;
}): Promise<ExternalRuntimeConnection | null> {
  const rows = await db.update(externalRuntimeConnections).set({
    ...normalizeConnectionFields(input),
    enabled: input.enabled,
    updatedAt: new Date(),
  }).where(and(
    eq(externalRuntimeConnections.orgId, input.orgId),
    eq(externalRuntimeConnections.id, input.id),
  )).returning();
  return rows[0] ?? null;
}

/**
 * Delete only the live callback configuration. Signed receipts and materialized
 * observations remain as orphan-tolerant historical evidence.
 */
export async function deleteExternalRuntimeConnection(
  orgId: string,
  id: string,
): Promise<ExternalRuntimeConnection | null> {
  const rows = await db.delete(externalRuntimeConnections).where(and(
    eq(externalRuntimeConnections.orgId, orgId),
    eq(externalRuntimeConnections.id, id),
  )).returning();
  return rows[0] ?? null;
}

function observationTime(event: ExternalRuntimeEvent): Date {
  return new Date(event.time);
}

async function ensureWorkflowPlaceholder(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    orgId: string;
    connectionId: string;
    externalWorkflowId: string;
    now: Date;
  },
): Promise<void> {
  await tx.insert(externalWorkflows).values({
    id: crypto.randomUUID(),
    orgId: input.orgId,
    connectionId: input.connectionId,
    externalWorkflowId: input.externalWorkflowId,
    name: input.externalWorkflowId,
    evidenceJson: [],
    lastSequence: -1,
    createdAt: input.now,
    updatedAt: input.now,
  }).onConflictDoNothing({
    target: [externalWorkflows.connectionId, externalWorkflows.externalWorkflowId],
  });
}

async function ensureRunPlaceholder(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    orgId: string;
    connectionId: string;
    externalWorkflowId: string;
    externalRunId: string;
    now: Date;
  },
): Promise<void> {
  await ensureWorkflowPlaceholder(tx, input);
  await tx.insert(externalRuns).values({
    id: crypto.randomUUID(),
    orgId: input.orgId,
    connectionId: input.connectionId,
    externalWorkflowId: input.externalWorkflowId,
    externalRunId: input.externalRunId,
    status: "unknown",
    evidenceJson: [],
    lastSequence: -1,
    createdAt: input.now,
    updatedAt: input.now,
  }).onConflictDoNothing({
    target: [externalRuns.connectionId, externalRuns.externalRunId],
  });
}

async function projectRecoveryCase(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    orgId: string;
    connectionId: string;
    event: ExternalRunEvent | ExternalStepEvent;
    now: Date;
  },
): Promise<void> {
  const { event } = input;
  const data = event.data;
  const externalStepId = "externalStepId" in data ? data.externalStepId : null;
  const subjectKind = externalStepId ? "step" : "run";
  const subjectKey = externalStepId
    ? `step:${data.externalRunId}:${externalStepId}`
    : `run:${data.externalRunId}`;
  const eventTime = observationTime(event);

  if (data.status === "failed") {
    await tx.insert(externalRecoveryCases).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      connectionId: input.connectionId,
      subjectKey,
      subjectKind,
      externalWorkflowId: data.externalWorkflowId,
      externalRunId: data.externalRunId,
      externalStepId,
      state: "detected",
      failureSnapshotJson: safeExternalPayload(data.snapshot),
      evidenceJson: safeEvidence(data.evidence),
      firstDetectedAt: eventTime,
      lastObservedAt: eventTime,
      observedRecoveredAt: null,
      lastSequence: data.sequence,
      lastEventId: event.id,
      createdAt: input.now,
      updatedAt: input.now,
    }).onConflictDoUpdate({
      target: [externalRecoveryCases.connectionId, externalRecoveryCases.subjectKey],
      set: {
        state: "detected",
        failureSnapshotJson: safeExternalPayload(data.snapshot),
        evidenceJson: safeEvidence(data.evidence),
        lastObservedAt: eventTime,
        observedRecoveredAt: null,
        lastSequence: data.sequence,
        lastEventId: event.id,
        updatedAt: input.now,
      },
      setWhere: lt(externalRecoveryCases.lastSequence, data.sequence),
    });
    return;
  }

  if (data.status === "succeeded") {
    await tx.update(externalRecoveryCases).set({
      state: "observed_recovered",
      evidenceJson: safeEvidence(data.evidence),
      lastObservedAt: eventTime,
      observedRecoveredAt: eventTime,
      lastSequence: data.sequence,
      lastEventId: event.id,
      updatedAt: input.now,
    }).where(and(
      eq(externalRecoveryCases.orgId, input.orgId),
      eq(externalRecoveryCases.connectionId, input.connectionId),
      eq(externalRecoveryCases.subjectKey, subjectKey),
      lt(externalRecoveryCases.lastSequence, data.sequence),
    ));
  }
}

async function projectEvent(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  input: {
    orgId: string;
    connectionId: string;
    event: ExternalRuntimeEvent;
    now: Date;
  },
): Promise<ExternalRuntimeProjectionState> {
  const { event } = input;
  const eventTime = observationTime(event);

  if (event.type === "io.janusly.external.workflow.observed") {
    const data = event.data;
    const rows = await tx.insert(externalWorkflows).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      connectionId: input.connectionId,
      externalWorkflowId: data.externalWorkflowId,
      name: scrubExternalString(data.name),
      version: data.version ? scrubExternalString(data.version) : null,
      snapshotJson: safeExternalPayload(data.snapshot),
      evidenceJson: safeEvidence(data.evidence),
      lastSequence: data.sequence,
      lastEventId: event.id,
      lastObservedAt: eventTime,
      createdAt: input.now,
      updatedAt: input.now,
    }).onConflictDoUpdate({
      target: [externalWorkflows.connectionId, externalWorkflows.externalWorkflowId],
      set: {
        name: scrubExternalString(data.name),
        version: data.version ? scrubExternalString(data.version) : null,
        snapshotJson: safeExternalPayload(data.snapshot),
        evidenceJson: safeEvidence(data.evidence),
        lastSequence: data.sequence,
        lastEventId: event.id,
        lastObservedAt: eventTime,
        updatedAt: input.now,
      },
      setWhere: lt(externalWorkflows.lastSequence, data.sequence),
    }).returning({ id: externalWorkflows.id });
    return rows.length > 0 ? "applied" : "stale";
  }

  if (event.type === "io.janusly.external.run.observed") {
    const data = event.data;
    await ensureWorkflowPlaceholder(tx, {
      ...input,
      externalWorkflowId: data.externalWorkflowId,
    });
    const rows = await tx.insert(externalRuns).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      connectionId: input.connectionId,
      externalWorkflowId: data.externalWorkflowId,
      externalRunId: data.externalRunId,
      status: data.status,
      startedAt: data.startedAt ? new Date(data.startedAt) : null,
      completedAt: data.completedAt ? new Date(data.completedAt) : null,
      snapshotJson: safeExternalPayload(data.snapshot),
      evidenceJson: safeEvidence(data.evidence),
      lastSequence: data.sequence,
      lastEventId: event.id,
      lastObservedAt: eventTime,
      createdAt: input.now,
      updatedAt: input.now,
    }).onConflictDoUpdate({
      target: [externalRuns.connectionId, externalRuns.externalRunId],
      set: {
        externalWorkflowId: data.externalWorkflowId,
        status: data.status,
        startedAt: data.startedAt ? new Date(data.startedAt) : null,
        completedAt: data.completedAt ? new Date(data.completedAt) : null,
        snapshotJson: safeExternalPayload(data.snapshot),
        evidenceJson: safeEvidence(data.evidence),
        lastSequence: data.sequence,
        lastEventId: event.id,
        lastObservedAt: eventTime,
        updatedAt: input.now,
      },
      setWhere: lt(externalRuns.lastSequence, data.sequence),
    }).returning({ id: externalRuns.id });
    if (rows.length > 0) {
      await projectRecoveryCase(tx, {
        orgId: input.orgId,
        connectionId: input.connectionId,
        event,
        now: input.now,
      });
    }
    return rows.length > 0 ? "applied" : "stale";
  }

  const data = event.data;
  await ensureRunPlaceholder(tx, {
    ...input,
    externalWorkflowId: data.externalWorkflowId,
    externalRunId: data.externalRunId,
  });
  const rows = await tx.insert(externalRunSteps).values({
    id: crypto.randomUUID(),
    orgId: input.orgId,
    connectionId: input.connectionId,
    externalWorkflowId: data.externalWorkflowId,
    externalRunId: data.externalRunId,
    externalStepId: data.externalStepId,
    name: scrubExternalString(data.name),
    status: data.status,
    attempt: data.attempt,
    startedAt: data.startedAt ? new Date(data.startedAt) : null,
    completedAt: data.completedAt ? new Date(data.completedAt) : null,
    snapshotJson: safeExternalPayload(data.snapshot),
    evidenceJson: safeEvidence(data.evidence),
    lastSequence: data.sequence,
    lastEventId: event.id,
    lastObservedAt: eventTime,
    createdAt: input.now,
    updatedAt: input.now,
  }).onConflictDoUpdate({
    target: [
      externalRunSteps.connectionId,
      externalRunSteps.externalRunId,
      externalRunSteps.externalStepId,
    ],
    set: {
      externalWorkflowId: data.externalWorkflowId,
      name: scrubExternalString(data.name),
      status: data.status,
      attempt: data.attempt,
      startedAt: data.startedAt ? new Date(data.startedAt) : null,
      completedAt: data.completedAt ? new Date(data.completedAt) : null,
      snapshotJson: safeExternalPayload(data.snapshot),
      evidenceJson: safeEvidence(data.evidence),
      lastSequence: data.sequence,
      lastEventId: event.id,
      lastObservedAt: eventTime,
      updatedAt: input.now,
    },
    setWhere: lt(externalRunSteps.lastSequence, data.sequence),
  }).returning({ id: externalRunSteps.id });
  if (rows.length > 0) {
    await projectRecoveryCase(tx, {
      orgId: input.orgId,
      connectionId: input.connectionId,
      event,
      now: input.now,
    });
  }
  return rows.length > 0 ? "applied" : "stale";
}

/**
 * Atomically claim one signed event and update the matching monotonic
 * projection. Exact retries return the original receipt; lower/equal sequence
 * events remain retained with `projectionState: "stale"`.
 */
export async function recordExternalRuntimeEvent(input: {
  orgId: string;
  connectionId: string;
  event: ExternalRuntimeEvent;
  now?: Date;
}): Promise<RecordExternalRuntimeEventResult> {
  assertSafeEventIdentities(input.event);
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const activeConnections = await tx.select({ id: externalRuntimeConnections.id })
      .from(externalRuntimeConnections)
      .where(and(
        eq(externalRuntimeConnections.id, input.connectionId),
        eq(externalRuntimeConnections.orgId, input.orgId),
        eq(externalRuntimeConnections.enabled, true),
      ))
      .limit(1);
    if (!activeConnections[0]) return { kind: "connection_not_found" };

    const inserted = await tx.insert(externalRuntimeEvents).values({
      id: crypto.randomUUID(),
      orgId: input.orgId,
      connectionId: input.connectionId,
      eventId: input.event.id,
      source: input.event.source,
      eventType: input.event.type,
      subject: input.event.subject ? scrubExternalString(input.event.subject) : null,
      eventTime: observationTime(input.event),
      sequence: input.event.data.sequence,
      payloadJson: safeExternalPayload(input.event) as object,
      projectionState: "pending",
      receivedAt: now,
    }).onConflictDoNothing({
      target: [
        externalRuntimeEvents.connectionId,
        externalRuntimeEvents.source,
        externalRuntimeEvents.eventId,
      ],
    }).returning();

    if (!inserted[0]) {
      const existing = await tx.select().from(externalRuntimeEvents).where(and(
        eq(externalRuntimeEvents.connectionId, input.connectionId),
        eq(externalRuntimeEvents.source, input.event.source),
        eq(externalRuntimeEvents.eventId, input.event.id),
      )).limit(1);
      if (!existing[0]) throw new Error("external_runtime_duplicate_receipt_missing");
      return { kind: "duplicate", receipt: existing[0] };
    }

    const projectionState = await projectEvent(tx, {
      orgId: input.orgId,
      connectionId: input.connectionId,
      event: input.event,
      now,
    });
    const updated = await tx.update(externalRuntimeEvents).set({
      projectionState,
    }).where(eq(externalRuntimeEvents.id, inserted[0].id)).returning();
    if (!updated[0]) throw new Error("external_runtime_receipt_update_failed");
    return { kind: projectionState, receipt: updated[0] };
  });
}

/** List recent external workflow projections for one organization. */
export async function listExternalWorkflows(orgId: string): Promise<ExternalWorkflow[]> {
  return db.select().from(externalWorkflows)
    .where(eq(externalWorkflows.orgId, orgId))
    .orderBy(desc(externalWorkflows.lastObservedAt), asc(externalWorkflows.externalWorkflowId))
    .limit(100);
}

/** List recent external run projections for one organization. */
export async function listExternalRuns(orgId: string): Promise<ExternalRun[]> {
  return db.select().from(externalRuns)
    .where(eq(externalRuns.orgId, orgId))
    .orderBy(desc(externalRuns.lastObservedAt), desc(externalRuns.createdAt))
    .limit(100);
}

/** List recent external step projections for one organization. */
export async function listExternalRunSteps(orgId: string): Promise<ExternalRunStep[]> {
  return db.select().from(externalRunSteps)
    .where(eq(externalRunSteps.orgId, orgId))
    .orderBy(desc(externalRunSteps.lastObservedAt), desc(externalRunSteps.createdAt))
    .limit(200);
}

/** List detected and observed-recovered external cases for one organization. */
export async function listExternalRecoveryCases(orgId: string): Promise<ExternalRecoveryCase[]> {
  return db.select().from(externalRecoveryCases)
    .where(eq(externalRecoveryCases.orgId, orgId))
    .orderBy(
      sql`case when ${externalRecoveryCases.state} = 'detected' then 0 else 1 end`,
      desc(externalRecoveryCases.lastObservedAt),
    )
    .limit(200);
}
