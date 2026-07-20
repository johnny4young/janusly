/**
 * Shared policy enforcement for executor-owned template scopes.
 *
 * `execute-node.ts` resolves ordinary workflow context before dispatch. Loop
 * items and sequential-agent history only exist later, so their executors use
 * this module to preserve the same redaction and strict-policy contract.
 */

import { appendEvent } from "./persistence";
import {
  MAX_RECORDED_UNRESOLVED_PATHS,
  UnresolvedTemplatePathError,
} from "./template";

export type LateBoundTemplateContext = {
  runId: string;
  nodeId: string;
  redactedValues?: string[];
  templatePolicy?: "lenient" | "strict";
};

/** Merge newly resolved secret/env values into the dispatcher redaction set. */
export function mergeLateBoundRedactions(
  ctx: LateBoundTemplateContext,
  redactedValues: string[],
): void {
  if (!ctx.redactedValues) return;
  for (const value of redactedValues) {
    if (!ctx.redactedValues.includes(value)) ctx.redactedValues.push(value);
  }
}

/** Record late-bound misses and enforce the workflow snapshot's strict mode. */
export async function enforceLateBoundTemplatePolicy(
  ctx: LateBoundTemplateContext,
  unresolvedPaths: string[],
): Promise<void> {
  if (unresolvedPaths.length === 0) return;
  const recordedPaths = unresolvedPaths.slice(0, MAX_RECORDED_UNRESOLVED_PATHS);
  const templatePolicy = ctx.templatePolicy ?? "lenient";
  await appendEvent(ctx.runId, ctx.nodeId, "template.unresolved_path", {
    count: unresolvedPaths.length,
    paths: recordedPaths,
    truncated: unresolvedPaths.length > recordedPaths.length,
    policy: templatePolicy,
  });
  if (templatePolicy === "strict") {
    throw new UnresolvedTemplatePathError(unresolvedPaths);
  }
}
