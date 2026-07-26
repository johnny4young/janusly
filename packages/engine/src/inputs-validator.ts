/**
 * Hand-rolled validator for the JSON-Schema-subset declared by
 * `WorkflowInputSchema` (in `@janusly/shared`). Walks the schema recursively
 * and aggregates every error in one pass — callers get a complete picture
 * instead of failing on the first issue.
 *
 * Used by `start-run.ts` (rejects malformed `POST /start` payloads with 400
 * via `WorkflowInputValidationError`) and any other entry point that consumes
 * a workflow's declared `inputs` shape.
 *
 * Invariants:
 * - Hand-rolled (no `ajv` dep) — consistent with the project's style for
 *   bounded grammars (see also `expression.ts`, `workflow-validation.ts`).
 *   The grammar is small enough that a 100kB validator dependency would be
 *   the wrong trade.
 * - The grammar must stay in lockstep with `WorkflowInputSchema` in
 *   `packages/shared/src/workflow.ts`. Adding a new primitive type means
 *   adding a branch to both files.
 */

import type { WorkflowInputSchemaShape } from "@janusly/shared";

/** Result returned by `validateInputs`. */
export type InputsValidationResult = { valid: true } | { valid: false; errors: string[] };

/**
 * Thrown by `startRun` when a workflow declared `inputs` and the run-start
 * payload doesn't satisfy the shape. The `POST /start` route handler in
 * `apps/api/src/routes/runs-routes.ts` catches and returns 400 with the
 * error list.
 */
export class WorkflowInputValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Workflow input validation failed: ${errors.join("; ")}`);
    this.name = "WorkflowInputValidationError";
    this.errors = errors;
  }
}

/**
 * Validate `value` against the JSON-Schema-subset declared in `schema`.
 * Returns `{ valid: true }` on success or `{ valid: false, errors }`
 * with a JSONPath-style location for every issue (e.g.
 * `"$.invoiceId is required"`, `"$.amount must be number, got string"`).
 *
 * The walk is depth-first; aggregated errors give the caller a complete
 * picture rather than one-error-at-a-time iterations.
 */
export function validateInputs(
  schema: WorkflowInputSchemaShape,
  value: unknown,
  path = "$",
): InputsValidationResult {
  const errors: string[] = [];
  walk(schema, value, path, errors);
  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}

/**
 * Fill declared defaults into a run-start payload.
 *
 * Returns a new value — the caller's payload is never mutated. A supplied
 * value always wins, including an explicit `null` or `false`, so only a
 * genuinely absent field takes its default. Object schemas recurse so nested
 * settings can be defaulted field by field, and a defaulted object fills its
 * own children before being returned.
 *
 * Run this BEFORE `validateInputs`: it is what lets a workflow declare a
 * required setting and still start from a trigger (whose payload carries the
 * event, never the declared fields) or from a bare `POST /start`.
 */
export function applyInputDefaults(schema: WorkflowInputSchemaShape, value: unknown): unknown {
  if (schema.type !== "object") {
    return value === undefined ? schema.default : value;
  }

  // Pick what to fill into. A wrong-typed supplied value or default is passed
  // through untouched so `validateInputs` reports the type error rather than
  // this function silently reshaping it.
  const base = value !== undefined ? value : schema.default;
  if (base !== undefined && !isPlainObject(base)) return base;

  const filled: Record<string, unknown> = { ...(base as Record<string, unknown> | undefined) };
  for (const [key, child] of Object.entries(schema.properties ?? {})) {
    const resolved = applyInputDefaults(child, filled[key]);
    if (resolved !== undefined) filled[key] = resolved;
  }
  // An absent optional object stays absent unless a child default gave it
  // content — otherwise every optional section would materialize as `{}`.
  if (base === undefined && Object.keys(filled).length === 0) return undefined;
  return filled;
}

function walk(schema: WorkflowInputSchemaShape, value: unknown, path: string, errors: string[]): void {
  if (!matchesType(schema.type, value)) {
    errors.push(`${path} must be ${schema.type}, got ${describeActual(value)}`);
    return; // Don't descend into mismatched types — generates noise.
  }

  if (schema.enum && !schema.enum.some((allowed) => isDeepEqual(allowed, value))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }

  if (schema.type === "object" && isPlainObject(value)) {
    const obj = value as Record<string, unknown>;
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in obj)) {
        errors.push(`${path}.${requiredKey} is required`);
      }
    }
    for (const [propName, propSchema] of Object.entries(schema.properties ?? {})) {
      if (propName in obj) {
        walk(propSchema, obj[propName], `${path}.${propName}`, errors);
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      walk(schema.items, value[i], `${path}[${i}]`, errors);
    }
  }
}

function matchesType(type: WorkflowInputSchemaShape["type"], value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
  }
}

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeActual(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, i) => isDeepEqual(item, b[i]));
  }
  const objA = a as Record<string, unknown>;
  const objB = b as Record<string, unknown>;
  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key) => isDeepEqual(objA[key], objB[key]));
}
