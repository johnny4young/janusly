/**
 * Typed config schemas for the Pass-2 noop-promotion path.
 *
 * Each entry here is a single non-union object schema describing the
 * runtime config shape for one operator-only node type. The schemas are
 * intentionally single-shape so they satisfy both Anthropic's
 * compiled-grammar cap and OpenAI's strict-mode rules (no `oneOf`, no
 * `propertyNames`, no open `additionalProperties`) — adding a new
 * promoted type is a single new entry here plus a dispatcher case in
 * `promote-noop.ts`.
 *
 * Used by `promote-noop.ts` (route-level Pass-2 path) only. The engine's
 * runtime is the source of truth for what each node type accepts — these
 * schemas are tighter guards that ensure the LLM never emits a promoted
 * node whose shape would fail the strict engine `WorkflowSchema`
 * downstream.
 */

import { z } from "zod";
import { ISO_DURATION_PATTERN } from "@janusly/shared";

/**
 * Typed config for the `wait_until` node. The engine's `resolveWaitUntilDelay`
 * parses `config.duration` as an ISO 8601 duration string (e.g. `"P3D"`,
 * `"PT12H"`, `"PT30M"`) and throws on missing / non-positive / malformed
 * values. Constraining to a non-empty string here means a successful
 * Pass-2 promotion never produces a `wait_until` node that fails at
 * execute time for a missing `duration`.
 */
export const AiWaitUntilConfigSchema = z.object({
  duration: z
    .string()
    .min(1)
    .regex(ISO_DURATION_PATTERN, "duration must be a valid ISO 8601 duration")
    .describe("ISO 8601 duration string. Examples: 'P3D' (3 days), 'PT12H' (12 hours), 'PT30M' (30 minutes)."),
});

export type AiWaitUntilConfig = z.infer<typeof AiWaitUntilConfigSchema>;

/**
 * System prompt for the `wait_until` Pass-2 promotion. The model
 * receives the noop's `config.hint` (the operator's verbatim wait
 * phrase) as the user prompt; this system message constrains the
 * conversion. The schema's `.describe()` annotation reinforces format
 * expectations on providers that surface it.
 */
export const WAIT_UNTIL_PROMOTE_SYSTEM_PROMPT = [
  "You convert a user's verbatim wait-for-time phrase into a strict ISO 8601 duration string.",
  "Output one field only: `duration`. Acceptable forms: 'P<n>D' (days), 'PT<n>H' (hours), 'PT<n>M' (minutes), 'PT<n>S' (seconds), or combinations like 'P1DT12H'.",
  "Examples: 'wait 3 days' -> 'P3D'; 'sleep for 12 hours' -> 'PT12H'; 'pause 30 minutes' -> 'PT30M'; 'wait one day and twelve hours' -> 'P1DT12H'.",
  "If the phrase does NOT contain a concrete parseable duration (e.g. 'wait for review', 'wait until they approve', 'wait a while'), reject by failing schema validation — emit a clearly-invalid value like an empty string. The caller treats schema rejection as a silent unpromoted-noop fallback.",
].join("\n");

/**
 * Permissive 5-field cron regex covering minute, hour, day-of-month,
 * month, day-of-week. Accepts numerics, `*`, comma lists, ranges
 * (`1-5`), and step values like `*<slash>15`. Aliases such as `@daily`
 * are intentionally rejected because the engine's `validateCronExpression`
 * requires exactly five fields.
 * The regex is a pre-filter — the engine's `cron-parser` is the
 * authoritative gate at save time. Pass-2's job is to reject
 * obviously-wrong shapes (e.g. "monday morning") before they
 * round-trip through the LLM SDK's structured-output validator.
 */
export const CRON_EXPRESSION_PATTERN =
  /^(?:[0-9*,\-/]+\s+){4}[0-9*,\-/]+$/;

function isBoundedInteger(value: string, min: number, max: number): boolean {
  if (!/^\d+$/.test(value)) return false;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max;
}

function isCronFieldWithinBounds(field: string, min: number, max: number): boolean {
  return field.split(",").every((segment) => {
    if (segment.length === 0) return false;
    const stepParts = segment.split("/");
    if (stepParts.length > 2) return false;
    const [rangePart, stepPart] = stepParts;
    if (!rangePart) return false;
    if (stepPart !== undefined && !isBoundedInteger(stepPart, 1, 999)) return false;
    if (rangePart === "*") return true;

    const rangeParts = rangePart.split("-");
    if (rangeParts.length > 2) return false;
    if (rangeParts.length === 2) {
      const [start, end] = rangeParts;
      if (!start || !end) return false;
      if (!isBoundedInteger(start, min, max) || !isBoundedInteger(end, min, max)) return false;
      return Number(start) <= Number(end);
    }

    return isBoundedInteger(rangePart, min, max);
  });
}

export function isEngineCompatibleCronExpression(cronExpression: string): boolean {
  if (!CRON_EXPRESSION_PATTERN.test(cronExpression)) return false;
  const fields = cronExpression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  return (
    isCronFieldWithinBounds(minute, 0, 59) &&
    isCronFieldWithinBounds(hour, 0, 23) &&
    isCronFieldWithinBounds(dayOfMonth, 1, 31) &&
    isCronFieldWithinBounds(month, 1, 12) &&
    isCronFieldWithinBounds(dayOfWeek, 0, 7)
  );
}

/**
 * Typed config for the `schedule` node. The engine's runtime resolver
 * (`packages/engine/src/schedule.ts:resolveScheduleConfig`) parses
 * `config.cronExpression` via `cron-parser`; constraining to a
 * non-empty cron-shaped string here means a successful Pass-2
 * promotion lands a node the save-time `syncWorkflowSchedules` hook
 * accepts. The engine fills in `enabled: true` when unset.
 */
export const AiScheduleConfigSchema = z.object({
  cronExpression: z
    .string()
    .min(1)
    .regex(CRON_EXPRESSION_PATTERN, "cronExpression must be a 5-field cron expression")
    .refine(isEngineCompatibleCronExpression, "cronExpression fields must be inside standard cron ranges")
    .describe("Standard 5-field cron expression. Examples: '0 9 * * 1-5' (weekdays 9am), '*/15 * * * *' (every 15 min), '0 0 * * *' (daily at midnight)."),
});

export type AiScheduleConfig = z.infer<typeof AiScheduleConfigSchema>;

/**
 * System prompt for the `schedule` Pass-2 promotion. The model
 * receives the operator's verbatim prompt and the noop's id as the
 * user-message body; this system message constrains the conversion
 * to a standard 5-field cron expression.
 */
export const SCHEDULE_PROMOTE_SYSTEM_PROMPT = [
  "You convert a user's verbatim schedule phrase into a strict 5-field cron expression.",
  "Output one field only: `cronExpression`. Format is `<minute> <hour> <day-of-month> <month> <day-of-week>`. Each field accepts numerics, `*`, comma lists, ranges (`1-5`), and step values (`*/15`). Do not emit aliases such as `@daily` or `@hourly`; expand them to five fields.",
  "Examples: 'every weekday at 9am' -> '0 9 * * 1-5'; 'every Monday at 9am' -> '0 9 * * 1'; 'every 15 minutes' -> '*/15 * * * *'; 'daily at midnight' -> '0 0 * * *'; 'first of every month' -> '0 0 1 * *'.",
  "Day-of-week uses 0-6 (Sunday=0). When the operator names a day, map it accordingly: Mon=1, Tue=2, Wed=3, Thu=4, Fri=5, Sat=6, Sun=0 (or 7).",
  "If the phrase does NOT contain a concrete parseable cadence (e.g. 'schedule a review', 'on demand', 'when needed'), reject by failing schema validation — emit a clearly-invalid value like an empty string or 'monday morning'. The caller treats schema rejection as a silent unpromoted-noop fallback.",
].join("\n");
