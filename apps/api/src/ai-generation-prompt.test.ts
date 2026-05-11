import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

describe("generate-workflow system prompt", () => {
  it("documents the current 11-node Anthropic grammar selection", () => {
    expect(indexSource).toContain("'approval', 'human_form', 'loop'");
    expect(indexSource).toContain("The platform supports 9 more operator-only types (multi_agent");
    expect(indexSource).toContain("Use 'human_form' when the prompt asks a person to provide structured data");
    expect(indexSource).toContain("use noop placeholders for teams/crews/groups that need multi_agent promotion");
    expect(indexSource).not.toContain("'approval', 'multi_agent', 'loop'");
  });
});
