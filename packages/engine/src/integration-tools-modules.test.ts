import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import * as integrationTools from "./integration-tools";
import * as github from "./integration-tooling/github";
import * as pagerduty from "./integration-tooling/pagerduty";
import * as slack from "./integration-tooling/slack";
import * as webhook from "./integration-tooling/webhook";

const EXPECTED_DEPENDENCIES = {
  github: ["shared"],
  pagerduty: ["shared"],
  shared: [],
  slack: ["shared"],
  webhook: ["shared"],
} as const;

describe("integration tool module architecture", () => {
  it("preserves the stable integration-tools.ts runtime surface", () => {
    expect(Object.keys(integrationTools).sort()).toEqual([
      "githubAddIssueCommentTool",
      "githubCreateIssueTool",
      "isWithinPagerDutyWorkingHours",
      "pagerDutyAcknowledgeTool",
      "pagerDutyIncidentGetTool",
      "pagerDutyPolicyEvaluateTool",
      "pagerDutySnoozeTool",
      "signWebhookPayload",
      "slackPostTool",
      "webhookSendTool",
    ]);
    expect(integrationTools.githubAddIssueCommentTool).toBe(github.githubAddIssueCommentTool);
    expect(integrationTools.githubCreateIssueTool).toBe(github.githubCreateIssueTool);
    expect(integrationTools.isWithinPagerDutyWorkingHours).toBe(
      pagerduty.isWithinPagerDutyWorkingHours,
    );
    expect(integrationTools.pagerDutyAcknowledgeTool).toBe(pagerduty.pagerDutyAcknowledgeTool);
    expect(integrationTools.pagerDutyIncidentGetTool).toBe(pagerduty.pagerDutyIncidentGetTool);
    expect(integrationTools.pagerDutyPolicyEvaluateTool).toBe(
      pagerduty.pagerDutyPolicyEvaluateTool,
    );
    expect(integrationTools.pagerDutySnoozeTool).toBe(pagerduty.pagerDutySnoozeTool);
    expect(integrationTools.signWebhookPayload).toBe(webhook.signWebhookPayload);
    expect(integrationTools.slackPostTool).toBe(slack.slackPostTool);
    expect(integrationTools.webhookSendTool).toBe(webhook.webhookSendTool);
  });

  it("owns the exact registered provider tool inventory", () => {
    const tools = [
      github.githubAddIssueCommentTool,
      github.githubCreateIssueTool,
      pagerduty.pagerDutyAcknowledgeTool,
      pagerduty.pagerDutyIncidentGetTool,
      pagerduty.pagerDutyPolicyEvaluateTool,
      pagerduty.pagerDutySnoozeTool,
      slack.slackPostTool,
      webhook.webhookSendTool,
    ];
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "github.add_issue_comment",
      "github.create_issue",
      "pagerduty.incident.acknowledge",
      "pagerduty.incident.get",
      "pagerduty.incident.snooze",
      "pagerduty.policy.evaluate",
      "slack.post",
      "webhook.send",
    ]);
    expect(tools.map((tool) => [tool.name, tool.writeSide])).toEqual([
      ["github.add_issue_comment", true],
      ["github.create_issue", true],
      ["pagerduty.incident.acknowledge", true],
      ["pagerduty.incident.get", false],
      ["pagerduty.policy.evaluate", false],
      ["pagerduty.incident.snooze", true],
      ["slack.post", true],
      ["webhook.send", true],
    ]);
  });

  it("keeps provider modules acyclic and the shared chokepoint singular", () => {
    const files = readdirSync(new URL("./integration-tooling", import.meta.url))
      .filter((name) => name.endsWith(".ts"))
      .sort();
    expect(files).toEqual(Object.keys(EXPECTED_DEPENDENCIES).map((name) => `${name}.ts`).sort());
    expect(existsSync(new URL("./integration-tools", import.meta.url))).toBe(false);

    const graph = new Map<string, string[]>();
    for (const name of Object.keys(EXPECTED_DEPENDENCIES)) {
      const source = readFileSync(
        new URL(`./integration-tooling/${name}.ts`, import.meta.url),
        "utf8",
      );
      expect(source).not.toMatch(/from\s+["']\.\.\/integration-tools["']/);
      expect(source).not.toMatch(/@octokit|@slack\/web-api|pagerduty\/sdk/);
      const dependencies = [...source.matchAll(/from\s+["']\.\/([^"']+)["']/g)]
        .map((match) => match[1])
        .sort();
      graph.set(name, dependencies);
    }
    expect(Object.fromEntries(graph)).toEqual(EXPECTED_DEPENDENCIES);

    const sharedSource = readFileSync(
      new URL("./integration-tooling/shared.ts", import.meta.url),
      "utf8",
    );
    expect(sharedSource).toContain("getCredentialByName");
    expect(sharedSource).toContain("resolveCredentialSecretRef");
    expect(sharedSource).toContain("getEngineRateLimiter");
    expect(sharedSource).toContain("getIntegrationUsageRecorder");

    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = (name: string) => {
      if (visiting.has(name)) throw new Error(`Integration tool import cycle at ${name}`);
      if (visited.has(name)) return;
      visiting.add(name);
      for (const dependency of graph.get(name) ?? []) visit(dependency);
      visiting.delete(name);
      visited.add(name);
    };
    for (const name of graph.keys()) visit(name);
    expect(visited.size).toBe(graph.size);
  });
});
