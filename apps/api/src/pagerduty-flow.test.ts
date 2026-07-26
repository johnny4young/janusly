import { describe, expect, it } from "vitest";

import { validateWorkflow } from "@janusly/engine/src/workflow-validation";
import { checkWorkflowReadiness } from "@janusly/engine/src/workflow-readiness";

import { compilePagerDutyFlow, isPagerDutyFlowPrompt } from "./pagerduty-flow";

describe("PagerDuty prompt workflow compiler", () => {
  it("recognizes off-hours PagerDuty automation but not unrelated incident prompts", () => {
    expect(isPagerDutyFlowPrompt("When PagerDuty alerts me after hours, acknowledge and snooze it")).toBe(true);
    expect(isPagerDutyFlowPrompt("Acknowledge this PagerDuty incident")).toBe(false);
    expect(isPagerDutyFlowPrompt("Summarize an incident and post it to Slack")).toBe(false);
  });

  it("builds a strict-valid deterministic graph from Spanish configuration", () => {
    const flow = compilePagerDutyFlow(
      "En PagerDuty, cuando el usuario PLOCALUSER esté en disponibilidad fuera de horario laboral 08:30 a 17:45 en America/Bogota, reconoce la alerta y aplázala por 12 horas. API credential pd-api, webhook credential pd-hook, requester operator@example.com.",
    );

    expect(flow).not.toBeNull();
    expect(validateWorkflow(flow!)).toEqual({ valid: true, issues: [] });
    expect(checkWorkflowReadiness(flow!).status).not.toBe("fail");
    expect(flow?.nodes.map((node) => node.type)).toEqual([
      "pagerduty_incident",
      "tool",
      "tool",
      "tool",
      "tool",
      "transform",
      "transform",
    ]);
    expect(flow?.nodes.find((node) => node.id === "on_pagerduty")?.config).toMatchObject({
      webhookCredential: "pd-hook",
    });
    expect(flow?.nodes.find((node) => node.id === "evaluate_policy")?.config).toMatchObject({
      input: {
        pagerDutyUserId: "PLOCALUSER",
        timeZone: "America/Bogota",
        workingHours: [{ days: [1, 2, 3, 4, 5], start: "08:30", end: "17:45" }],
      },
    });
    expect(flow?.nodes.find((node) => node.id === "snooze_incident")?.config).toMatchObject({
      input: { durationSeconds: 43_200 },
    });
    expect(Object.keys(flow?.ui?.positions ?? {}).sort()).toEqual(
      flow?.nodes.map((node) => node.id).sort(),
    );
    expect(Math.max(...Object.values(flow?.ui?.positions ?? {}).map(({ x }) => x))).toBe(540);
  });

  it("adds AI only when the prompt explicitly requests post-action enrichment", () => {
    const deterministic = compilePagerDutyFlow("PagerDuty off-hours: acknowledge and snooze for 2 hours.");
    const enriched = compilePagerDutyFlow("PagerDuty off-hours: acknowledge, snooze for 2 hours, and add an AI summary.");

    expect(deterministic?.nodes.some((node) => node.type === "ai")).toBe(false);
    expect(enriched?.nodes.find((node) => node.id === "summarize_action")?.type).toBe("ai");
  });
});
