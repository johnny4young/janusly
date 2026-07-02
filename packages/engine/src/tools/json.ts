/**
 * JSON-manipulation tools (`json.pick` / `.set` / `.merge` / `.jq`) plus the
 * prototype-pollution-safe path/merge helpers they share.
 *
 * Used by: `packages/engine/src/tool-registry.ts` (spreads `jsonTools`).
 */

import { z } from "zod";
import { getByPath } from "../template";
import { evaluateJsonJq, parseJsonJqQuery } from "../json-jq";
import { defineTool } from "./tool-types";

// Path segments that target the prototype chain. Refusing them keeps a
// user-controlled path from injecting values that show up as inherited
// properties on the result object (or on objects downstream that consume
// it). Defense-in-depth — even though our spread-based copy avoids global
// `Object.prototype` mutation, leaving `.polluted` reachable via the
// prototype chain of the returned value is a footgun for callers.
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function setByPath(source: unknown, path: string, value: unknown): unknown {
  const segments = path.split(".").filter(Boolean);
  if (segments.length === 0) return source;
  if (segments.some((segment) => PROTOTYPE_KEYS.has(segment))) {
    throw new Error(`json.set refuses prototype-targeting path segments: ${path}`);
  }
  const root: Record<string, unknown> = isPlainObject(source) ? { ...(source as Record<string, unknown>) } : {};
  let cursor: Record<string, unknown> = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    const next = cursor[key];
    cursor[key] = isPlainObject(next) ? { ...(next as Record<string, unknown>) } : {};
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]] = value;
  return root;
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [key, value] of Object.entries(b)) {
    if (PROTOTYPE_KEYS.has(key)) continue; // guard against prototype-pollution via JSON.parse'd inputs
    const left = out[key];
    if (isPlainObject(left) && isPlainObject(value)) {
      out[key] = deepMerge(left as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const jsonPickInput = z.object({
  path: z.string().min(1),
  source: z.unknown().optional(),
});
const jsonPickOutput = z.object({
  value: z.unknown(),
});

const jsonSetInput = z.object({
  source: z.unknown().optional(),
  path: z.string().min(1),
  value: z.unknown(),
});
const jsonSetOutput = z.object({ value: z.unknown() });

const jsonMergeInput = z.object({
  a: z.record(z.string(), z.unknown()),
  b: z.record(z.string(), z.unknown()),
});
const jsonMergeOutput = z.object({ value: z.record(z.string(), z.unknown()) });

const jsonJqInput = z.object({
  source: z.unknown().optional(),
  query: z.string().min(1),
}).superRefine((input, ctx) => {
  try {
    parseJsonJqQuery(input.query);
  } catch (err) {
    ctx.addIssue({
      code: "custom",
      path: ["query"],
      message: err instanceof Error ? err.message : "Invalid json.jq query",
    });
  }
});
const jsonJqOutput = z.object({ value: z.unknown() });

export const jsonTools = {
  "json.pick": defineTool({
    name: "json.pick",
    description: "Pick a value from workflow context using a dot path.",
    inputSchema: jsonPickInput,
    outputSchema: jsonPickOutput,
    inputExample: { path: "1.output.statusCode" },
    async execute(input, context) {
      const source = (input.source as Record<string, unknown> | undefined) ?? context;
      return { value: getByPath(source, input.path) };
    },
  }),

  "json.set": defineTool({
    name: "json.set",
    description: "Return a copy of `source` with `value` set at the dotted `path`.",
    inputSchema: jsonSetInput,
    outputSchema: jsonSetOutput,
    inputExample: { source: { user: { id: 1 } }, path: "user.name", value: "Ada" },
    async execute(input) {
      return { value: setByPath(input.source ?? {}, input.path, input.value) };
    },
  }),

  "json.merge": defineTool({
    name: "json.merge",
    description: "Deep-merge two objects; `b` wins on key conflicts. Arrays are replaced wholesale.",
    inputSchema: jsonMergeInput,
    outputSchema: jsonMergeOutput,
    inputExample: { a: { user: { id: 1 } }, b: { user: { name: "Ada" } } },
    async execute(input) {
      return { value: deepMerge(input.a, input.b) };
    },
  }),

  "json.jq": defineTool({
    name: "json.jq",
    description: "Run a safe jq-style selector subset against JSON data.",
    inputSchema: jsonJqInput,
    outputSchema: jsonJqOutput,
    inputExample: { source: { users: [{ email: "a@example.com" }] }, query: ".users[] | .email" },
    async execute(input, context) {
      const source = input.source ?? context;
      return { value: evaluateJsonJq(source, input.query) };
    },
  }),
};
