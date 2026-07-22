/**
 * Real-Postgres coverage for trigger resolution boundaries that a route mock
 * cannot prove: active-parent filtering, latest-version selection, tenant
 * isolation, and targeted recovery of a persisted event.
 */

import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";

import { db, workflows, workflowVersions } from "@janusly/db";
import { AmbiguousTriggerNodeError, resolveTriggerNode } from "../triggerEventsRepo";

const TAG = `${Date.now()}-${process.pid}`;
const ORG = `it-trigger-resolver-${TAG}`;
const OTHER_ORG = `it-trigger-resolver-other-${TAG}`;

function triggerDag(aliasKey: string) {
  return {
    dslVersion: "1.0",
    nodes: [{ id: "inbox", type: "email_received", config: { aliasKey } }],
    edges: [],
  };
}

async function seedWorkflow(args: {
  id: string;
  orgId?: string;
  deletedAt?: Date;
  versions: string[];
}): Promise<void> {
  const orgId = args.orgId ?? ORG;
  await db.insert(workflows).values({
    id: args.id,
    orgId,
    name: args.id,
    deletedAt: args.deletedAt,
  });
  await db.insert(workflowVersions).values(args.versions.map((aliasKey, index) => ({
    id: `${args.id}-v${index + 1}`,
    orgId,
    workflowId: args.id,
    version: index + 1,
    dagJson: triggerDag(aliasKey),
  })));
}

afterAll(async () => {
  for (const orgId of [ORG, OTHER_ORG]) {
    await db.delete(workflowVersions).where(eq(workflowVersions.orgId, orgId));
    await db.delete(workflows).where(eq(workflows.orgId, orgId));
  }
});

describe("resolveTriggerNode (real Postgres)", () => {
  it("uses the latest version and excludes a soft-deleted workflow", async () => {
    const deletedId = `a-deleted-${TAG}`;
    const activeId = `z-active-${TAG}`;
    await seedWorkflow({ id: deletedId, deletedAt: new Date(), versions: ["shared"] });
    await seedWorkflow({ id: activeId, versions: ["old", "shared"] });

    const resolved = await resolveTriggerNode(
      ORG,
      "email_received",
      (config) => config.aliasKey === "shared",
    );

    expect(resolved).toMatchObject({
      workflowId: activeId,
      workflowVersionId: `${activeId}-v2`,
    });
  });

  it("targets recovery to the persisted workflow instead of the first same-type trigger", async () => {
    const firstId = `a-first-${TAG}`;
    const targetId = `z-target-${TAG}`;
    await seedWorkflow({ id: firstId, versions: ["same-type"] });
    await seedWorkflow({ id: targetId, versions: ["same-type"] });

    const resolved = await resolveTriggerNode(
      ORG,
      "email_received",
      () => true,
      { workflowId: targetId },
    );

    expect(resolved?.workflowId).toBe(targetId);
  });

  it("fails closed when one selector matches multiple active workflows", async () => {
    const firstId = `ambiguous-a-${TAG}`;
    const secondId = `ambiguous-b-${TAG}`;
    await seedWorkflow({ id: firstId, versions: ["duplicate-selector"] });
    await seedWorkflow({ id: secondId, versions: ["duplicate-selector"] });

    await expect(resolveTriggerNode(
      ORG,
      "email_received",
      (config) => config.aliasKey === "duplicate-selector",
    )).rejects.toBeInstanceOf(AmbiguousTriggerNodeError);
  });

  it("does not resolve a target from another organization", async () => {
    const otherId = `other-${TAG}`;
    await seedWorkflow({ id: otherId, orgId: OTHER_ORG, versions: ["private"] });

    const resolved = await resolveTriggerNode(
      ORG,
      "email_received",
      () => true,
      { workflowId: otherId },
    );

    expect(resolved).toBeNull();
  });
});
