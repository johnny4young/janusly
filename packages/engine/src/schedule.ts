/**
 * `schedule` node — a passthrough trigger that succeeds immediately with
 * `{ triggeredAt }` as its output. The actual cron firing happens outside
 * the executor: a BullMQ repeatable job (registered by
 * `schedule-scheduler.ts` at workflow save) spawns a new run on each
 * tick; the run then executes this node like any other.
 *
 * The executor does not gate on `enabled`. Pause/resume is enforced at
 * registration time — a disabled schedule has no BullMQ job, so the run
 * never spawns. If an operator manually clicks `POST /start` against a
 * workflow whose schedule node is disabled, the node still runs (and
 * downstream nodes execute) — that's intentional: manual start is a
 * separate trigger surface.
 *
 * Used by:
 * - `node-registry.ts` registers `schedule: scheduleExecutor`.
 * - `workflow-validation.ts` calls `validateCronExpression` to reject
 *   malformed cron strings at `POST /validate` time.
 *
 * Invariants:
 * - Cron parsing goes through `cron-parser`. The same validator is the
 *   gate at three layers: workflow-validation (operator save), the
 *   scheduler module (defense-in-depth on the persistence path), and the
 *   executor (last line — refuses to succeed on a malformed config that
 *   slipped through validation).
 */

import { CronExpressionParser } from "cron-parser";
import type { NodeExecutor } from "./node-registry";

export type ScheduleConfig = {
  /** Standard 5-field cron expression (minute / hour / day-of-month / month / day-of-week). */
  cronExpression: string;
  /** When `false`, the BullMQ repeatable job is removed at save time. `resolveScheduleConfig` defaults to `true`. */
  enabled: boolean;
};

/**
 * Parse and validate a cron expression. Throws on any malformed input.
 * Returns the next firing time (ISO string) for surfaces that want to
 * preview when the schedule will fire next.
 */
export function validateCronExpression(cronExpression: unknown): { nextFireAt: string } {
  if (typeof cronExpression !== "string" || cronExpression.trim().length === 0) {
    throw new Error("schedule.cronExpression is required (e.g. \"0 9 * * *\")");
  }
  const expression = cronExpression.trim();
  if (expression.split(/\s+/).length !== 5) {
    throw new Error(`schedule.cronExpression must be a 5-field cron expression, got: ${cronExpression}`);
  }
  try {
    const interval = CronExpressionParser.parse(expression);
    // The parser's CronDate is Luxon-backed, so `toISOString()` is typed
    // `string | null` (null only for an invalid DateTime, unreachable here
    // because `parse()` already succeeded) — guard to satisfy the type.
    const nextFireAt = interval.next().toISOString();
    if (nextFireAt === null) {
      throw new Error("cron expression produced no valid next firing time");
    }
    return { nextFireAt };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`schedule.cronExpression must be a valid cron expression, got: ${cronExpression} (${detail})`);
  }
}

/**
 * Resolve and normalize the executor-facing slice of a `schedule` node's
 * config. Throws on validation errors so the runtime surfaces a failure
 * on `node.failed` rather than silently succeeding.
 */
export function resolveScheduleConfig(config: unknown): ScheduleConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("schedule node requires a config object");
  }
  const obj = config as Record<string, unknown>;
  const cronExpression = obj.cronExpression;
  validateCronExpression(cronExpression);

  let enabled = true;
  if (obj.enabled !== undefined) {
    if (typeof obj.enabled !== "boolean") {
      throw new Error(`schedule.enabled must be a boolean when set, got: ${typeof obj.enabled}`);
    }
    enabled = obj.enabled;
  }

  return { cronExpression: String(cronExpression).trim(), enabled };
}

/**
 * Executor: validates the config and succeeds immediately. Output records
 * `triggeredAt` so downstream nodes / templates can read when the schedule
 * fired (e.g. `{{schedule.output.triggeredAt}}`).
 */
export const scheduleExecutor: NodeExecutor<"schedule"> = async (ctx) => {
  const config = resolveScheduleConfig(ctx.config);
  const triggeredAt = new Date().toISOString();
  return {
    status: "completed",
    output: { triggeredAt, cronExpression: config.cronExpression },
  };
};
