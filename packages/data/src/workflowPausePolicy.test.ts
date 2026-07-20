/**
 * The pause decision table, pinned. Each case documents WHY the entry
 * points differ — the asymmetry is the contract, not an accident.
 */

import { describe, expect, it } from "vitest";

import { resolveWorkflowPauseAction } from "./workflowPausePolicy";

describe("resolveWorkflowPauseAction", () => {
  it("proceeds for an active workflow at every entry point", () => {
    for (const entry of ["start", "trigger", "schedule"] as const) {
      expect(resolveWorkflowPauseAction("active", entry)).toEqual({ kind: "proceed" });
    }
  });

  it("fails OPEN on an unresolvable status — an unreadable row is not evidence of a pause", () => {
    for (const entry of ["start", "trigger", "schedule"] as const) {
      expect(resolveWorkflowPauseAction(null, entry)).toEqual({ kind: "proceed" });
      expect(resolveWorkflowPauseAction(undefined, entry)).toEqual({ kind: "proceed" });
    }
  });

  it("start: rejects naming the ACTUAL cause — breaker vs upstream are different operator situations", () => {
    expect(resolveWorkflowPauseAction("paused_circuit_breaker", "start")).toEqual({
      kind: "reject", code: "workflow_circuit_breaker_paused", status: "paused_circuit_breaker",
    });
    expect(resolveWorkflowPauseAction("paused_upstream_degraded", "start")).toEqual({
      kind: "reject", code: "upstream_degraded", status: "paused_upstream_degraded",
    });
  });

  it("trigger: buffers — the upstream committed the event and will never re-send it", () => {
    expect(resolveWorkflowPauseAction("paused_circuit_breaker", "trigger")).toEqual({
      kind: "buffer", reason: "paused_circuit_breaker",
    });
  });

  it("schedule: drops — replaying hours of cron ticks on resume is a thundering herd", () => {
    expect(resolveWorkflowPauseAction("paused_upstream_degraded", "schedule")).toEqual({
      kind: "drop", reason: "paused_upstream_degraded",
    });
  });

  it("an unknown future pause status still pauses (defaults to the generic branch per entry point)", () => {
    // A new pause source added tomorrow must contain runs from day one even
    // before this table learns its name.
    expect(resolveWorkflowPauseAction("paused_maintenance", "start")).toMatchObject({ kind: "reject", code: "upstream_degraded" });
    expect(resolveWorkflowPauseAction("paused_maintenance", "trigger")).toMatchObject({ kind: "buffer" });
    expect(resolveWorkflowPauseAction("paused_maintenance", "schedule")).toMatchObject({ kind: "drop" });
  });
});
