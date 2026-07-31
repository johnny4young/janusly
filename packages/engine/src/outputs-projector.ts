/**
 * Project a workflow's declared `outputs` (output-name → template string)
 * into a concrete record by rendering each template against the run's
 * terminal context. The projection runs once when the run flips to
 * `succeeded`, before `runs.outputJson` is persisted.
 *
 * Used by `persistence-ports/run.ts:computeRunOutputs` (called from
 * `updateRunStatusFromNodes`) and consumable by any caller that has the
 * full context dict in hand.
 *
 * Invariants:
 * - Reuses `renderTemplate` so the substitution language stays one thing
 *   across configs, tool inputs, condition evaluation, and outputs. Don't
 *   reimplement template substitution here.
 * - Output templates are persisted and user-visible, so they must never
 *   resolve `{{secret.*}}` or `{{env.*}}` references. Those are redacted
 *   before calling the shared renderer.
 * - Empty / missing template paths resolve to `""` (per the
 *   `renderTemplate` contract). Authors who want `null` should write the
 *   template that resolves to a literal null source.
 */

import { renderTemplate } from "./template";

const PERSISTENCE_ONLY_REF = /{{\s*(?:secret|env)\.[^}]+\s*}}/gi;

/**
 * Render every template in `outputsSpec` against `{ context, inputs }` and
 * return the resulting record. The keys are preserved verbatim; the values
 * are whatever `renderTemplate` returns for the template string. A single
 * template reference (`"{{x.y}}"`) preserves the resolved value's native
 * type (number / array / object / boolean) so JSON-typed outputs survive
 * intact; multi-reference / interpolated strings (`"hello {{name}}"`) are
 * still coerced to strings.
 *
 * Returns `{}` for an empty spec — callers can treat that as "no projection
 * configured."
 */
export function projectOutputs(
  outputsSpec: Record<string, string>,
  context: Record<string, unknown>,
  inputs: unknown = {},
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, template] of Object.entries(outputsSpec)) {
    result[key] = renderTemplate(maskPersistenceOnlyRefs(template), { context, inputs });
  }
  return result;
}

function maskPersistenceOnlyRefs(template: string): string {
  return template.replace(PERSISTENCE_ONLY_REF, "[redacted]");
}
