/** Real-Postgres proof for signed external-runtime shadow reconciliation. */

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  db,
  externalRecoveryCases,
  externalRunSteps,
  externalRuns,
  externalRuntimeConnections,
  externalRuntimeEvents,
  externalWorkflows,
} from "@janusly/db";
import type { ExternalRuntimeEvent } from "@janusly/shared";
import {
  createExternalRuntimeConnection,
  getExternalRuntimeConnection,
  listExternalRecoveryCases,
  listExternalRunSteps,
  listExternalRuns,
  listExternalRuntimeConnections,
  listExternalWorkflows,
  recordExternalRuntimeEvent,
} from "../externalRuntimeRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-external-runtime-${TAG}`;
const OTHER_ORG = `it-external-runtime-other-${TAG}`;
let connectionId = "";

function stepEvent(input: {
  id: string;
  sequence: number;
  status: "failed" | "succeeded";
}): ExternalRuntimeEvent {
  return {
    specversion: "1.0",
    id: input.id,
    source: "urn:temporal:payments",
    type: "io.janusly.external.step.observed",
    time: new Date(1_800_000_000_000 + input.sequence * 1_000).toISOString(),
    data: {
      externalWorkflowId: "payment-reconciliation",
      externalRunId: "run-42",
      externalStepId: "charge",
      name: "Charge customer",
      sequence: input.sequence,
      status: input.status,
      attempt: 1,
      snapshot: {
        message: "provider rejected sk-aaaaaaaaaaaaaaaaaaaaaaaa",
        authorization: "Bearer hidden",
      },
      evidence: [{
        kind: "trace",
        label: "Trace sk-bbbbbbbbbbbbbbbbbbbbbbbb",
        locator: "https://trace.example.test/sk-cccccccccccccccccccccccc",
      }],
    },
  };
}

afterAll(async () => {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.delete(externalRecoveryCases).where(eq(externalRecoveryCases.orgId, orgId));
    await db.delete(externalRunSteps).where(eq(externalRunSteps.orgId, orgId));
    await db.delete(externalRuns).where(eq(externalRuns.orgId, orgId));
    await db.delete(externalWorkflows).where(eq(externalWorkflows.orgId, orgId));
    await db.delete(externalRuntimeEvents).where(eq(externalRuntimeEvents.orgId, orgId));
    await db.delete(externalRuntimeConnections).where(eq(externalRuntimeConnections.orgId, orgId));
  }
});

describe("external runtime shadow mode (real Postgres)", () => {
  it("keeps connection management tenant-scoped", async () => {
    const connection = await createExternalRuntimeConnection({
      orgId: ORG,
      name: "Temporal production",
      runtimeKey: `temporal-${TAG}`,
      signingCredentialName: "temporal-observer",
      enabled: true,
      createdBy: "admin-1",
    });
    connectionId = connection.id;

    await expect(getExternalRuntimeConnection(ORG, connection.id)).resolves.toMatchObject({
      orgId: ORG,
      runtimeKey: `temporal-${TAG}`,
    });
    await expect(getExternalRuntimeConnection(OTHER_ORG, connection.id)).resolves.toBeNull();
    await expect(listExternalRuntimeConnections(ORG)).resolves.toEqual([
      expect.objectContaining({ id: connection.id, orgId: ORG }),
    ]);
  });

  it("claims duplicates, ignores stale state, and observes a later recovery", async () => {
    const failed = stepEvent({ id: `failed-${TAG}`, sequence: 4, status: "failed" });
    const duplicateResults = await Promise.all([
      recordExternalRuntimeEvent({ orgId: ORG, connectionId, event: failed }),
      recordExternalRuntimeEvent({ orgId: ORG, connectionId, event: failed }),
    ]);
    expect(duplicateResults.map((result) => result.kind).sort()).toEqual(["applied", "duplicate"]);

    const stale = await recordExternalRuntimeEvent({
      orgId: ORG,
      connectionId,
      event: stepEvent({ id: `stale-${TAG}`, sequence: 3, status: "succeeded" }),
    });
    expect(stale.kind).toBe("stale");
    if (stale.kind !== "stale") throw new Error(`expected stale receipt, got ${stale.kind}`);
    expect((await listExternalRunSteps(ORG))[0]).toMatchObject({
      externalStepId: "charge",
      status: "failed",
      lastSequence: 4,
    });
    expect((await listExternalRecoveryCases(ORG))[0]).toMatchObject({
      state: "detected",
      lastSequence: 4,
    });

    const recovered = await recordExternalRuntimeEvent({
      orgId: ORG,
      connectionId,
      event: stepEvent({ id: `recovered-${TAG}`, sequence: 5, status: "succeeded" }),
    });
    expect(recovered.kind).toBe("applied");
    const cases = await listExternalRecoveryCases(ORG);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      state: "observed_recovered",
      lastSequence: 5,
    });
    expect(cases[0]?.observedRecoveredAt).toBeInstanceOf(Date);

    const receipts = await db.select().from(externalRuntimeEvents).where(and(
      eq(externalRuntimeEvents.orgId, ORG),
      eq(externalRuntimeEvents.connectionId, connectionId),
    ));
    expect(receipts).toHaveLength(3);
    expect(receipts.find((row) => row.eventId === stale.receipt.eventId)?.projectionState)
      .toBe("stale");

    const persistedFailure = receipts.find((row) => row.eventId === failed.id)?.payloadJson;
    expect(JSON.stringify(persistedFailure)).not.toContain("sk-aaaaaaaa");
    expect(JSON.stringify(persistedFailure)).not.toContain("Bearer hidden");
    expect(JSON.stringify(persistedFailure)).toContain("[redacted]");
  });

  it("creates bounded parent placeholders for out-of-order run and step events", async () => {
    await expect(listExternalWorkflows(ORG)).resolves.toEqual([
      expect.objectContaining({
        externalWorkflowId: "payment-reconciliation",
        name: "payment-reconciliation",
        lastSequence: -1,
      }),
    ]);
    await expect(listExternalRuns(ORG)).resolves.toEqual([
      expect.objectContaining({
        externalRunId: "run-42",
        status: "unknown",
        lastSequence: -1,
      }),
    ]);
  });

  it("rechecks enabled tenant ownership at the durable claim boundary", async () => {
    await db.update(externalRuntimeConnections).set({ enabled: false }).where(and(
      eq(externalRuntimeConnections.orgId, ORG),
      eq(externalRuntimeConnections.id, connectionId),
    ));
    await expect(recordExternalRuntimeEvent({
      orgId: ORG,
      connectionId,
      event: stepEvent({ id: `revoked-${TAG}`, sequence: 6, status: "failed" }),
    })).resolves.toEqual({ kind: "connection_not_found" });
    await db.update(externalRuntimeConnections).set({ enabled: true }).where(and(
      eq(externalRuntimeConnections.orgId, ORG),
      eq(externalRuntimeConnections.id, connectionId),
    ));
  });

  it("rejects secret-shaped identity fields before any receipt is written", async () => {
    const unsafe = stepEvent({
      id: "sk-aaaaaaaaaaaaaaaaaaaaaaaa",
      sequence: 8,
      status: "failed",
    });
    await expect(recordExternalRuntimeEvent({
      orgId: ORG,
      connectionId,
      event: unsafe,
    })).rejects.toThrow("external_runtime_sensitive_identity");
    const receipts = await db.select().from(externalRuntimeEvents).where(and(
      eq(externalRuntimeEvents.orgId, ORG),
      eq(externalRuntimeEvents.eventId, unsafe.id),
    ));
    expect(receipts).toEqual([]);
  });
});
