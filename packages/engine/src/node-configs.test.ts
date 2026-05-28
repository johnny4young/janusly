/**
 * Unit tests for per-node-type config schemas. Each schema validates
 * the REQUIRED fields the corresponding executor relies on; optional
 * fields are loose. Tests cover three shapes per schema where applicable:
 *  - rejects an obvious typo on a required field
 *  - accepts the canonical config
 *  - extra unknown keys flow through (passthrough)
 *
 * Schemas with no required fields (`approval`, `webhook`, `noop`, etc.)
 * only get a "passthrough" smoke.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AgentNodeConfigSchema,
  AiNodeConfigSchema,
  ApprovalNodeConfigSchema,
  ConditionNodeConfigSchema,
  HttpNodeConfigSchema,
  HumanFormNodeConfigSchema,
  JoinNodeConfigSchema,
  LoopNodeConfigSchema,
  McpToolNodeConfigSchema,
  MultiAgentNodeConfigSchema,
  NODE_CONFIG_SCHEMAS,
  NoopNodeConfigSchema,
  ParallelForkNodeConfigSchema,
  RouterNodeConfigSchema,
  ScheduleNodeConfigSchema,
  SubworkflowNodeConfigSchema,
  ToolNodeConfigSchema,
  TransformNodeConfigSchema,
  WaitUntilNodeConfigSchema,
  WebhookNodeConfigSchema,
  parseNodeConfig,
} from "./node-configs";
import { nodeTypeValues } from "@janusly/shared/src/workflow";

describe("HttpNodeConfigSchema", () => {
  it("rejects missing url", () => {
    expect(() => HttpNodeConfigSchema.parse({ method: "GET" })).toThrow();
  });
  it("rejects typo'd url field", () => {
    expect(() => HttpNodeConfigSchema.parse({ uri: "https://example.com" })).toThrow();
  });
  it("accepts canonical shape", () => {
    const parsed = HttpNodeConfigSchema.parse({
      url: "https://example.com",
      method: "POST",
      headers: { "x-foo": "bar" },
    });
    expect(parsed.url).toBe("https://example.com");
    expect(parsed.method).toBe("POST");
  });
  it("accepts extra keys via passthrough", () => {
    const parsed = HttpNodeConfigSchema.parse({
      url: "https://example.com",
      futureFeature: { enabled: true },
    });
    expect(parsed.url).toBe("https://example.com");
  });
});

describe("ConditionNodeConfigSchema", () => {
  it("rejects empty expression", () => {
    expect(() => ConditionNodeConfigSchema.parse({ expression: "" })).toThrow();
  });
  it("accepts canonical shape", () => {
    const parsed = ConditionNodeConfigSchema.parse({ expression: "input.x > 0" });
    expect(parsed.expression).toBe("input.x > 0");
  });
});

describe("ToolNodeConfigSchema", () => {
  it("rejects missing tool", () => {
    expect(() => ToolNodeConfigSchema.parse({ input: {} })).toThrow();
  });
  it("accepts canonical shape", () => {
    const parsed = ToolNodeConfigSchema.parse({ tool: "http.request", input: { url: "https://example.com" } });
    expect(parsed.tool).toBe("http.request");
  });
});

describe("AgentNodeConfigSchema", () => {
  it("accepts an empty config (all fields optional)", () => {
    expect(() => AgentNodeConfigSchema.parse({})).not.toThrow();
  });
  it("accepts canonical shape with goal + planner", () => {
    const parsed = AgentNodeConfigSchema.parse({
      goal: "Convert text to uppercase",
      planner: "rules",
      maxSteps: 5,
    });
    expect(parsed.goal).toBe("Convert text to uppercase");
    expect(parsed.planner).toBe("rules");
  });
  it("rejects an invalid planner value", () => {
    expect(() => AgentNodeConfigSchema.parse({ planner: "other" })).toThrow();
  });
});

describe("MultiAgentNodeConfigSchema", () => {
  it("accepts an empty config", () => {
    expect(() => MultiAgentNodeConfigSchema.parse({})).not.toThrow();
  });
  it("accepts a canonical multi-agent shape", () => {
    const parsed = MultiAgentNodeConfigSchema.parse({
      agents: [{ name: "summarizer", goal: "Summarize the input" }],
      mode: "sequential",
      aggregation: "last",
    });
    expect(parsed.mode).toBe("sequential");
  });
});

describe("AgentReflectionNodeConfigSchema", () => {
  it("accepts an empty config", () => {
    expect(() => z.object({}).passthrough().parse({})).not.toThrow();
  });
});

describe("LoopNodeConfigSchema", () => {
  it("accepts an empty config (executor handles undefined items)", () => {
    expect(() => LoopNodeConfigSchema.parse({ mapping: {} })).not.toThrow();
  });
  it("accepts items as a template string", () => {
    const parsed = LoopNodeConfigSchema.parse({ items: "{{input.items}}" });
    expect(parsed.items).toBe("{{input.items}}");
  });
  it("accepts items as an already-resolved array", () => {
    const parsed = LoopNodeConfigSchema.parse({ items: [1, 2, 3] });
    expect(Array.isArray(parsed.items)).toBe(true);
  });
});

describe("RouterNodeConfigSchema", () => {
  it("accepts an empty candidates list", () => {
    expect(() => RouterNodeConfigSchema.parse({})).not.toThrow();
  });
  it("rejects a non-array candidates", () => {
    expect(() => RouterNodeConfigSchema.parse({ candidates: "not-an-array" })).toThrow();
  });
});

describe("TransformNodeConfigSchema", () => {
  it("accepts an empty mapping", () => {
    expect(() => TransformNodeConfigSchema.parse({})).not.toThrow();
  });
  it("accepts a mapping object", () => {
    const parsed = TransformNodeConfigSchema.parse({ mapping: { out: "{{input.value}}" } });
    expect(parsed).toBeDefined();
  });
});

describe("AiNodeConfigSchema", () => {
  it("accepts an empty config", () => {
    expect(() => AiNodeConfigSchema.parse({})).not.toThrow();
  });
  it("accepts a prompt-only config", () => {
    const parsed = AiNodeConfigSchema.parse({ prompt: "Summarize" });
    expect(parsed.prompt).toBe("Summarize");
  });
  it("accepts a promptRef config", () => {
    const parsed = AiNodeConfigSchema.parse({ promptRef: { name: "summarize-v1" } });
    expect(parsed.promptRef?.name).toBe("summarize-v1");
  });
  it("rejects an invalid promptRef (missing name)", () => {
    expect(() => AiNodeConfigSchema.parse({ promptRef: {} })).toThrow();
  });
});

describe("ApprovalNodeConfigSchema", () => {
  it("accepts an empty config (message optional)", () => {
    expect(() => ApprovalNodeConfigSchema.parse({})).not.toThrow();
  });
});

describe("HumanFormNodeConfigSchema", () => {
  it("accepts a canonical shape (executor's downstream WorkflowInputSchema gates the schema field)", () => {
    const parsed = HumanFormNodeConfigSchema.parse({
      title: "Approve",
      schema: { type: "object", properties: { ok: { type: "boolean" } } },
    });
    expect(parsed.title).toBe("Approve");
  });
  it("accepts a missing schema (downstream parse is the real gate)", () => {
    expect(() => HumanFormNodeConfigSchema.parse({ title: "Approve" })).not.toThrow();
  });
});

describe("SubworkflowNodeConfigSchema", () => {
  it("rejects missing workflowId", () => {
    expect(() => SubworkflowNodeConfigSchema.parse({})).toThrow();
  });
  it("accepts canonical shape", () => {
    const parsed = SubworkflowNodeConfigSchema.parse({ workflowId: "wf-1" });
    expect(parsed.workflowId).toBe("wf-1");
  });
});

describe("WaitUntilNodeConfigSchema", () => {
  it("rejects missing duration", () => {
    expect(() => WaitUntilNodeConfigSchema.parse({})).toThrow();
  });
  it("accepts canonical shape", () => {
    const parsed = WaitUntilNodeConfigSchema.parse({ duration: "5m" });
    expect(parsed.duration).toBe("5m");
  });
});

describe("ScheduleNodeConfigSchema", () => {
  it("rejects missing cronExpression", () => {
    expect(() => ScheduleNodeConfigSchema.parse({ enabled: true })).toThrow();
  });
  it("accepts canonical shape", () => {
    const parsed = ScheduleNodeConfigSchema.parse({ cronExpression: "0 3 * * *" });
    expect(parsed.cronExpression).toBe("0 3 * * *");
  });
});

describe("McpToolNodeConfigSchema", () => {
  it("rejects missing connectionAlias", () => {
    expect(() => McpToolNodeConfigSchema.parse({ toolName: "list" })).toThrow();
  });
  it("rejects missing toolName", () => {
    expect(() => McpToolNodeConfigSchema.parse({ connectionAlias: "notion" })).toThrow();
  });
  it("accepts canonical shape", () => {
    const parsed = McpToolNodeConfigSchema.parse({
      connectionAlias: "notion",
      toolName: "pages.read",
      input: { id: "abc" },
    });
    expect(parsed.connectionAlias).toBe("notion");
  });
});

describe("ParallelForkNodeConfigSchema", () => {
  it("accepts an empty config", () => {
    expect(() => ParallelForkNodeConfigSchema.parse({})).not.toThrow();
  });
});

describe("JoinNodeConfigSchema", () => {
  it("accepts an empty config", () => {
    expect(() => JoinNodeConfigSchema.parse({})).not.toThrow();
  });
});

describe("WebhookNodeConfigSchema / NoopNodeConfigSchema (passthrough placeholders)", () => {
  it("accepts arbitrary keys", () => {
    expect(() => WebhookNodeConfigSchema.parse({ futureKey: 123 })).not.toThrow();
    expect(() => NoopNodeConfigSchema.parse({ futureKey: 123 })).not.toThrow();
  });
});

describe("NODE_CONFIG_SCHEMAS registry", () => {
  it("covers every NodeType in the closed enum", () => {
    const enumKeys = new Set(nodeTypeValues as readonly string[]);
    const registryKeys = new Set(Object.keys(NODE_CONFIG_SCHEMAS));
    for (const key of enumKeys) {
      expect(registryKeys.has(key)).toBe(true);
    }
    for (const key of registryKeys) {
      expect(enumKeys.has(key)).toBe(true);
    }
  });
});

describe("parseNodeConfig helper", () => {
  it("dispatches to the right schema", () => {
    const parsed = parseNodeConfig("http", { url: "https://example.com" });
    expect(parsed.url).toBe("https://example.com");
  });
  it("throws on an unknown type", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => parseNodeConfig("bogus" as any, {})).toThrow(/unknown node type/);
  });
  it("throws on invalid input for a known type", () => {
    expect(() => parseNodeConfig("http", { method: "GET" })).toThrow();
  });
});
