import { describe, expect, it, vi } from "vitest";

vi.mock("./tool-registry", () => ({
  listPlannerTools: vi.fn(() => {
    throw new Error("unrepresentable tool schema");
  }),
}));

import { planAgentToolWithLLM } from "./agent-planner";

describe("planAgentToolWithLLM — catalog fallback", () => {
  it("degrades to the rules planner when tool-schema projection throws", async () => {
    const llm = { generateText: vi.fn() };
    const result = await planAgentToolWithLLM(
      { goal: "uppercase this value", value: "safe" },
      {},
      [],
      llm as never,
    );

    expect(result).toMatchObject({
      tool: "text.uppercase",
      input: { value: "safe" },
      mode: "fallback",
      aiError: "unrepresentable tool schema",
    });
    expect(llm.generateText).not.toHaveBeenCalled();
  });
});
