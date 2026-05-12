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

  it("keeps AI generation aware of revenue-grade integration tools without expanding the node-type grammar", () => {
    expect(indexSource).toContain("'email.send'|'slack.post'|'github.create_issue'|'webhook.send'");
    expect(indexSource).toContain("emit the tool name only");
    expect(indexSource).toContain("The operator fills credential names, destinations, and richer inputs");
  });

  it("routes incident, Slack, and GitHub prompts to the incident-triage fallback template", () => {
    expect(indexSource).toContain('text.includes("incident")');
    expect(indexSource).toContain('text.includes("slack")');
    expect(indexSource).toContain('text.includes("github")');
    expect(indexSource).toContain('"incident-triage"');
  });
});
