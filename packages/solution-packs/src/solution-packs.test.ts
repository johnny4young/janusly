import { describe, it, expect } from "vitest";
import { WorkflowSchema } from "@janusly/shared";
import {
  listSolutionPacks,
  listPublicSolutionPacks,
  getSolutionPack,
  SolutionPackSchema,
  SOLUTION_PACK_CATEGORIES,
  SOLUTION_PACK_FAILURE_MODES,
} from "./index";

describe("solution packs catalog", () => {
  const packs = listSolutionPacks();

  it("loads the three ICP packs with unique ids", () => {
    expect(packs.length).toBe(3);
    const ids = packs.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("failed-payment-recovery");
    expect(ids).toContain("incident-triage");
    expect(ids).toContain("support-escalation");
  });

  it("every pack passes the schema and a closed category", () => {
    for (const pack of packs) {
      expect(() => SolutionPackSchema.parse(pack)).not.toThrow();
      expect(SOLUTION_PACK_CATEGORIES).toContain(pack.category);
    }
  });

  it("every pack workflow is a structurally valid Workflow shape", () => {
    for (const pack of packs) {
      const parsed = WorkflowSchema.safeParse(pack.workflowJson);
      expect(parsed.success, `${pack.id} workflow shape`).toBe(true);
      expect(pack.workflowJson.nodes.length).toBeGreaterThan(0);
    }
  });

  it("every failure fixture references a node that exists in its workflow", () => {
    for (const pack of packs) {
      const nodeIds = new Set(pack.workflowJson.nodes.map((n) => n.id));
      const fixtureIds = new Set<string>();
      for (const fixture of pack.failureFixtures) {
        expect(nodeIds.has(fixture.failedNodeId), `${pack.id}:${fixture.id}`).toBe(true);
        expect(fixtureIds.has(fixture.id), `${pack.id}:${fixture.id} duplicated`).toBe(false);
        fixtureIds.add(fixture.id);
      }
    }
  });

  it("covers every deterministic failure mode in the catalog", () => {
    const covered = new Set(packs.flatMap((pack) => pack.failureFixtures.map((fixture) => fixture.failureMode)));
    expect([...covered].sort()).toEqual([...SOLUTION_PACK_FAILURE_MODES].sort());
  });

  it("every pack has at least one sample payload and one failure fixture", () => {
    for (const pack of packs) {
      expect(pack.samplePayloads.length).toBeGreaterThan(0);
      expect(pack.failureFixtures.length).toBeGreaterThan(0);
    }
  });

  it("required credentials are well-formed (name + kind + purpose)", () => {
    for (const pack of packs) {
      for (const cred of pack.requiredCredentials) {
        expect(cred.name.length).toBeGreaterThan(0);
        expect(cred.kind.length).toBeGreaterThan(0);
        expect(cred.purpose.length).toBeGreaterThan(0);
      }
    }
  });

  it("getSolutionPack resolves a known id and returns null for an unknown one", () => {
    expect(getSolutionPack("incident-triage")?.id).toBe("incident-triage");
    expect(getSolutionPack("does-not-exist")).toBeNull();
  });

  it("public projection exposes safe drill descriptors but not raw workflow or error internals", () => {
    const publicPacks = listPublicSolutionPacks();
    expect(publicPacks.length).toBe(3);
    for (const pub of publicPacks) {
      expect(pub).not.toHaveProperty("workflowJson");
      expect(pub).not.toHaveProperty("samplePayloads");
      expect(pub.nodeCount).toBeGreaterThan(0);
      expect(pub.samplePayloadIds.length).toBe(pub.sampleCount);
      expect(pub.failureFixtureIds.length).toBe(pub.failureCount);
      expect(pub.failureFixtures.length).toBe(pub.failureCount);
      for (const fixture of pub.failureFixtures) {
        expect(fixture).toEqual({
          id: expect.any(String),
          label: expect.any(String),
          description: expect.any(String),
          failureMode: expect.any(String),
        });
        expect(fixture).not.toHaveProperty("failedNodeId");
        expect(fixture).not.toHaveProperty("errorJson");
      }
    }
  });
});
