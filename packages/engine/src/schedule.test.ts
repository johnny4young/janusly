import { describe, expect, it } from "vitest";
import { resolveScheduleConfig, scheduleExecutor, validateCronExpression } from "./schedule";

describe("validateCronExpression", () => {
  it("accepts standard 5-field cron expressions and returns a next-fire ISO string", () => {
    const result = validateCronExpression("0 9 * * *");
    expect(result.nextFireAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("accepts every-N-minutes expressions", () => {
    expect(() => validateCronExpression("*/5 * * * *")).not.toThrow();
    expect(() => validateCronExpression("0 */6 * * *")).not.toThrow();
  });

  it("rejects empty / missing cron expressions with a descriptive error", () => {
    expect(() => validateCronExpression("")).toThrow(/cronExpression is required/);
    expect(() => validateCronExpression("   ")).toThrow(/cronExpression is required/);
    expect(() => validateCronExpression(undefined)).toThrow(/cronExpression is required/);
    expect(() => validateCronExpression(null)).toThrow(/cronExpression is required/);
    expect(() => validateCronExpression(42)).toThrow(/cronExpression is required/);
  });

  it("rejects malformed cron strings", () => {
    expect(() => validateCronExpression("99 9 * * *")).toThrow(/valid cron expression/);
    expect(() => validateCronExpression("0 25 * * *")).toThrow(/valid cron expression/);
  });

  it("rejects non-5-field cron expressions so schedules stay minute-granular", () => {
    expect(() => validateCronExpression("not a cron")).toThrow(/5-field cron expression/);
    expect(() => validateCronExpression("0 0 9 * * *")).toThrow(/5-field cron expression/);
  });
});

describe("resolveScheduleConfig", () => {
  it("returns a normalized config when cron is valid and enabled defaults to true", () => {
    expect(resolveScheduleConfig({ cronExpression: "0 9 * * *" })).toEqual({
      cronExpression: "0 9 * * *",
      enabled: true,
    });
  });

  it("respects an explicit enabled=false", () => {
    expect(resolveScheduleConfig({ cronExpression: "0 9 * * *", enabled: false })).toEqual({
      cronExpression: "0 9 * * *",
      enabled: false,
    });
  });

  it("trims surrounding whitespace from cronExpression", () => {
    expect(resolveScheduleConfig({ cronExpression: "  0 9 * * *  " }).cronExpression).toBe("0 9 * * *");
  });

  it("rejects non-object config", () => {
    expect(() => resolveScheduleConfig(null)).toThrow(/config object/);
    expect(() => resolveScheduleConfig([])).toThrow(/config object/);
    expect(() => resolveScheduleConfig("nope")).toThrow(/config object/);
  });

  it("rejects non-boolean enabled when set", () => {
    expect(() => resolveScheduleConfig({ cronExpression: "0 9 * * *", enabled: "yes" })).toThrow(/enabled must be a boolean/);
    expect(() => resolveScheduleConfig({ cronExpression: "0 9 * * *", enabled: 1 })).toThrow(/enabled must be a boolean/);
  });

  it("propagates cron validation errors", () => {
    expect(() => resolveScheduleConfig({ cronExpression: "bogus" })).toThrow(/5-field cron expression/);
    expect(() => resolveScheduleConfig({})).toThrow(/cronExpression is required/);
  });
});

describe("scheduleExecutor", () => {
  it("succeeds immediately with triggeredAt and the resolved cron echoed back", async () => {
    const result = await scheduleExecutor({
      runId: "r1",
      nodeId: "s1",
      orgId: "default",
      workflowId: "w1",
      config: { cronExpression: "0 9 * * *", enabled: true },
      context: {},
    });
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.output?.cronExpression).toBe("0 9 * * *");
      expect(typeof result.output?.triggeredAt).toBe("string");
      expect(String(result.output?.triggeredAt)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("still succeeds when enabled=false (pause is enforced at the BullMQ register layer, not in the executor)", async () => {
    const result = await scheduleExecutor({
      runId: "r1",
      nodeId: "s1",
      orgId: "default",
      workflowId: "w1",
      config: { cronExpression: "0 9 * * *", enabled: false },
      context: {},
    });
    expect(result.status).toBe("completed");
  });

  it("fails fast on invalid config", async () => {
    await expect(
      scheduleExecutor({
        runId: "r1",
        nodeId: "s1",
        orgId: "default",
        workflowId: "w1",
        config: { cronExpression: "" },
        context: {},
      }),
    ).rejects.toThrow(/cronExpression is required/);
  });
});
