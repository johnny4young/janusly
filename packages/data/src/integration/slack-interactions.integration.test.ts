/** Real-Postgres coverage for Slack callback idempotency and tenant-safe CAS. */

import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import {
  db,
  recoveryItems,
  slackInteractionConnections,
  slackInteractionReceipts,
} from "@janusly/db";
import {
  applySlackRecoveryInteraction,
  createSlackInteractionConnection,
  getSlackInteractionConnection,
  listSlackInteractionConnections,
} from "../slackInteractionsRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-slack-${TAG}`;
const OTHER_ORG = `it-slack-other-${TAG}`;
const ITEM_ID = `slack-item-${TAG}`;

afterAll(async () => {
  await db.delete(slackInteractionReceipts).where(eq(slackInteractionReceipts.orgId, ORG));
  await db.delete(slackInteractionReceipts).where(eq(slackInteractionReceipts.orgId, OTHER_ORG));
  await db.delete(slackInteractionConnections).where(eq(slackInteractionConnections.orgId, ORG));
  await db.delete(slackInteractionConnections).where(eq(slackInteractionConnections.orgId, OTHER_ORG));
  await db.delete(recoveryItems).where(eq(recoveryItems.orgId, ORG));
});

describe("Slack interactions (real Postgres)", () => {
  it("scopes connection reads to one organization", async () => {
    const mine = await createSlackInteractionConnection({
      orgId: ORG,
      name: "Primary operations",
      teamId: `T-${TAG}`,
      signingCredentialName: "slack-signing",
      userMappings: [{ slackUserId: "U1", userId: "operator-1" }],
      enabled: true,
      createdBy: "admin-1",
    });
    await createSlackInteractionConnection({
      orgId: OTHER_ORG,
      name: "Other operations",
      teamId: `T-OTHER-${TAG}`,
      signingCredentialName: "slack-signing",
      userMappings: [],
      enabled: true,
      createdBy: "admin-2",
    });

    await expect(getSlackInteractionConnection(ORG, mine.id)).resolves.toMatchObject({ orgId: ORG });
    await expect(getSlackInteractionConnection(OTHER_ORG, mine.id)).resolves.toBeNull();
    await expect(listSlackInteractionConnections(ORG)).resolves.toEqual([
      expect.objectContaining({ id: mine.id, orgId: ORG }),
    ]);
  });

  it("claims one receipt across concurrent replicas and mutates exactly once", async () => {
    const connection = (await listSlackInteractionConnections(ORG))[0]!;
    await db.insert(recoveryItems).values({
      id: ITEM_ID,
      orgId: ORG,
      deadLetterId: `dlq-${TAG}`,
      status: "open",
      slaTargetAt: new Date(Date.now() + 60_000),
      createdBy: "operator-1",
    });
    const input = {
      id: `receipt-${TAG}`,
      orgId: ORG,
      connectionId: connection.id,
      recoveryItemId: ITEM_ID,
      userId: "operator-1",
      action: "acknowledge" as const,
    };
    const results = await Promise.all([
      applySlackRecoveryInteraction(input),
      applySlackRecoveryInteraction(input),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual(["applied", "duplicate"]);
    const rows = await db.select().from(recoveryItems).where(and(
      eq(recoveryItems.orgId, ORG),
      eq(recoveryItems.id, ITEM_ID),
    ));
    expect(rows[0]).toMatchObject({ status: "acknowledged", owner: null });

    const assigned = await applySlackRecoveryInteraction({
      ...input,
      id: `receipt-assign-${TAG}`,
      action: "assign_to_me",
    });
    expect(assigned).toMatchObject({
      kind: "applied",
      before: { owner: null },
      after: { owner: "operator-1" },
    });
  });

  it("cannot mutate another organization's recovery item", async () => {
    const connection = (await listSlackInteractionConnections(ORG))[0]!;
    const result = await applySlackRecoveryInteraction({
      id: `receipt-cross-org-${TAG}`,
      orgId: OTHER_ORG,
      connectionId: connection.id,
      recoveryItemId: ITEM_ID,
      userId: "intruder",
      action: "assign_to_me",
    });
    expect(result).toEqual({ kind: "not_found" });
    const rows = await db.select().from(recoveryItems).where(eq(recoveryItems.id, ITEM_ID));
    expect(rows[0]?.owner).toBe("operator-1");
  });
});
