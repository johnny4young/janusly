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
