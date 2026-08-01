import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { agentNodeExecutors } from "./node-executors/agents";
import { aiNodeExecutors } from "./node-executors/ai";
import { delegatedNodeExecutors } from "./node-executors/delegated";
import { mcpNodeExecutors } from "./node-executors/mcp";
import { transportNodeExecutors } from "./node-executors/transport";
import { waitingNodeExecutors } from "./node-executors/waiting";
import { nodeRegistry } from "./node-registry";

const EXPECTED_MODULES = [
  "agents.ts",
  "ai-shared.ts",
  "ai.ts",
  "delegated.ts",
  "mcp.ts",
  "registry.ts",
  "transport.ts",
  "types.ts",
  "waiting.ts",
] as const;

const EXPECTED_EXECUTOR_ORDER = [
  "http",
  "condition",
  "transform",
  "loop",
  "tool",
  "agent",
  "multi_agent",
  "agent_reflection",
  "ai",
  "webhook",
  "approval",
  "human_form",
  "noop",
  "mcp_tool",
  "subworkflow",
  "wait_until",
  "parallel_fork",
  "join",
  "schedule",
  "webhook_received",
  "email_received",
  "file_dropped",
  "mcp_server_event",
  "pagerduty_incident",
] as const;

const SEGMENTS = [
  transportNodeExecutors,
  agentNodeExecutors,
  aiNodeExecutors,
  waitingNodeExecutors,
  mcpNodeExecutors,
  delegatedNodeExecutors,
] as const;

const DIRECT_TYPE_CONSUMERS = [
  "approval-timeout.ts",
  "parallel-fork.ts",
  "schedule.ts",
  "subworkflow.ts",
  "triggers.ts",
  "wait-until.ts",
] as const;

describe("node executor module architecture", () => {
  it("preserves the exhaustive registry order and composition", () => {
    const composed = Object.assign({}, ...SEGMENTS);

    expect(nodeRegistry).toEqual(composed);
    expect(Object.keys(nodeRegistry)).toEqual(EXPECTED_EXECUTOR_ORDER);
    expect(SEGMENTS.map((segment) => Object.keys(segment).length)).toEqual([5, 3, 1, 4, 1, 10]);
  });

  it("keeps the compatibility module runtime surface exact", async () => {
    const publicModule = await import("./node-registry");

    expect(Object.keys(publicModule).sort()).toEqual([
      "ToolResultPolicyError",
      "executeRegisteredNode",
      "isRegisteredNodeType",
      "isWriteSideNode",
      "nodeRegistry",
    ].sort());
  });

  it("keeps focused modules bounded, acyclic, and ESM-safe", () => {
    const files = readdirSync(new URL("./node-executors", import.meta.url))
      .filter((name) => name.endsWith(".ts"))
      .sort();

    expect(files).toEqual([...EXPECTED_MODULES].sort());
    expect(existsSync(new URL("./node-registry", import.meta.url))).toBe(false);

    for (const file of files) {
      const source = readFileSync(new URL(`./node-executors/${file}`, import.meta.url), "utf8");
      expect(source.split("\n").length, file).toBeLessThanOrEqual(500);
      expect(source, file).not.toMatch(/from\s+["']\.\.\/node-registry["']/);
      if (file !== "registry.ts") {
        expect(source, file).not.toMatch(/from\s+["']\.\/registry["']/);
      }
    }
  });

  it("keeps delegated executors on the direct type-only dependency", () => {
    for (const file of DIRECT_TYPE_CONSUMERS) {
      const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
      expect(source, file).toContain('from "./node-executors/types"');
      expect(source, file).not.toContain('from "./node-registry"');
    }
  });
});
