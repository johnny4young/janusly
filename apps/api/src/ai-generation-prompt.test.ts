import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The original test read `./index.ts` as a string. After the route-registry
// split, the prompts live in `ai-prompts.ts` and the fallback router in
// `ai-runtime.ts`; assertions point at those files instead.
const promptsSource = readFileSync(new URL("./ai-prompts.ts", import.meta.url), "utf8");
const runtimeSource = readFileSync(new URL("./ai-runtime.ts", import.meta.url), "utf8");

describe("generate-workflow system prompt", () => {
  it("documents the current 11-node Anthropic grammar selection", () => {
    expect(promptsSource).toContain("'approval', 'human_form', 'loop'");
    expect(promptsSource).toContain("The platform supports 9 more operator-only types (multi_agent");
    expect(promptsSource).toContain("Use 'human_form' when the prompt asks a person to provide structured data");
    expect(promptsSource).toContain("use noop placeholders for teams/crews/groups that need multi_agent promotion");
    expect(promptsSource).not.toContain("'approval', 'multi_agent', 'loop'");
  });

  it("keeps AI generation aware of write-side tools without expanding the node-type grammar", () => {
    expect(promptsSource).toContain("'email.send'|'pdf.generate'|'slack.post'|'github.create_issue'|'webhook.send'");
    expect(promptsSource).toContain("emit the tool name only");
    expect(promptsSource).toContain("The operator fills credential names, destinations, and richer inputs");
  });

  it("routes incident, Slack, and GitHub prompts to the incident-triage fallback template", () => {
    expect(runtimeSource).toContain('text.includes("incident")');
    expect(runtimeSource).toContain('text.includes("slack")');
    expect(runtimeSource).toContain('text.includes("github")');
    expect(runtimeSource).toContain('"incident-triage"');
  });

  it("teaches the LLM the Pass-2 wait-intent id-prefix convention", () => {
    expect(promptsSource).toContain("WAIT-INTENT NAMING");
    expect(promptsSource).toContain("`wait_`");
    expect(promptsSource).toContain("`sleep_`");
    expect(promptsSource).toContain("auto-detects these by id prefix");
    expect(promptsSource).toContain("EXAMPLE — wait-intent prompt");
  });
});
