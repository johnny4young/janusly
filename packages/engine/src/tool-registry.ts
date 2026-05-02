/**
 * Tool registry — the catalog of side-effect operations the runtime can run on
 * behalf of an `agent` planner or a `tool` node.
 *
 * Each entry is a typed `ToolDefinition` carrying Zod schemas for both input
 * and output. `validateToolInput` and `executeTool` route through `safeParse`
 * so executors receive a parsed, typed input and bad outputs surface
 * immediately rather than crashing a downstream consumer.
 *
 * Used by:
 * - `packages/engine/src/node-registry.ts` — `tool` node and the agent loop
 *   call `executeTool`.
 * - `apps/api/src/index.ts` `GET /tools` — returns `listTools()` to the AI
 *   Studio for inspector rendering.
 *
 * Invariants:
 * - Tool registration is global, not per-org. `auth.orgId` scoping happens
 *   downstream in the runtime.
 * - The JSON shape `listTools()` produces is part of the public API surface
 *   that `apps/web` reads via `ToolSchema`. Don't change `name`,
 *   `description`, `required`, `optional`, or `inputExample` field names.
 * - `http.request` goes through `fetchHttpTarget` so the SSRF + DNS-rebinding
 *   pin is preserved on every call.
 * - Adding a new tool without `inputSchema` and `outputSchema` is a TypeScript
 *   error thanks to the `satisfies Record<string, ToolDefinition>` constraint.
 */

import { z } from "zod";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { RE2 } from "re2-wasm";
import { getByPath } from "./template";
import { fetchHttpTarget } from "./http-policy";
import { filterCsv, parseCsv, stringifyCsv } from "./csv";
import { parseIsoDuration } from "./iso-duration";
import { evaluateJsonJq, parseJsonJqQuery } from "./json-jq";

/**
 * Public-facing tool metadata returned by `listTools()` for the AI Studio.
 *
 * Derived at runtime from each tool's Zod input schema (see `describeShape`),
 * so producers can't drift from consumers — change the schema and the JSON
 * shape updates automatically.
 */
export type ToolSchema = {
  name: string;
  description: string;
  required?: string[];
  optional?: string[];
  inputExample?: Record<string, unknown>;
};

/**
 * Internal definition shape for one registered tool.
 *
 * `TIn`/`TOut` are inferred at the call site — registering a tool with literal
 * `z.object({...})` schemas gives the executor a fully-typed `input` and a
 * type-checked `Promise<output>`.
 */
type ToolDefinition<
  TIn extends z.ZodTypeAny = z.ZodTypeAny,
  TOut extends z.ZodTypeAny = z.ZodTypeAny,
> = {
  name: string;
  description: string;
  inputSchema: TIn;
  outputSchema: TOut;
  inputExample?: Record<string, unknown>;
  execute: (
    input: z.infer<TIn>,
    context: Record<string, unknown>,
  ) => Promise<z.infer<TOut>>;
};

/**
 * Identity helper that exists purely so TypeScript infers `TIn`/`TOut` from
 * the literal schema values when registering a tool. Without it the registry
 * would widen `execute`'s `input` to `unknown` under the `satisfies` clause.
 */
function defineTool<TIn extends z.ZodTypeAny, TOut extends z.ZodTypeAny>(
  def: ToolDefinition<TIn, TOut>,
): ToolDefinition<TIn, TOut> {
  return def;
}

const httpRequestInput = z.object({
  url: z.string().min(1),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
});
const httpRequestOutput = z.object({
  statusCode: z.number(),
  ok: z.boolean(),
  body: z.string(),
});

const textUppercaseInput = z.object({
  value: z.string().min(1),
});
const textUppercaseOutput = z.object({
  value: z.string(),
});

const jsonPickInput = z.object({
  path: z.string().min(1),
  source: z.unknown().optional(),
});
const jsonPickOutput = z.object({
  value: z.unknown(),
});

/* -------- text/json/csv/time/crypto tool schemas -------- */

// text.*
const textValueInput = z.object({ value: z.string() });
const textValueOutput = z.object({ value: z.string() });

const textReplaceInput = z.object({
  value: z.string(),
  search: z.string().min(1),
  replacement: z.string(),
  all: z.boolean().optional(),
});
const textRegexInput = z.object({
  value: z.string(),
  pattern: z.string().min(1),
  flags: z.string().optional(),
  group: z.number().int().min(0).optional(),
}).superRefine((input, ctx) => {
  try {
    createSafeRegex(input.pattern, input.flags);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid regular expression";
    ctx.addIssue({
      code: "custom",
      path: message.includes("Unsupported regular expression flags") || message.includes("Duplicate regular expression flag") ? ["flags"] : ["pattern"],
      message,
    });
  }
});
const textRegexOutput = z.object({ matches: z.array(z.string()) });

// json.*
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

// csv.*
const csvCell = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const csvObjectRows = z.array(z.record(z.string(), csvCell));
const csvArrayRows = z.array(z.array(csvCell));

const csvParseInput = z.object({
  value: z.string(),
  hasHeader: z.boolean().optional(),
});
const csvParseOutput = z.object({ rows: z.unknown() });

const csvStringifyInput = z.object({
  rows: z.union([csvObjectRows, csvArrayRows]),
  header: z.array(z.string()).optional(),
}).superRefine((input, ctx) => {
  if (input.rows.length === 0) return;
  const rowsAreArrays = Array.isArray(input.rows[0]);
  if (rowsAreArrays && input.header !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["header"],
      message: "header is only valid with object rows",
    });
  }
  if (!rowsAreArrays && input.header === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["header"],
      message: "header is required when rows are objects",
    });
  }
});
const csvStringifyOutput = z.object({ value: z.string() });

const csvFilterInput = z.object({
  rows: z.array(z.record(z.string(), z.string())),
  where: z.record(z.string(), z.string()),
});
const csvFilterOutput = z.object({ rows: z.array(z.record(z.string(), z.string())) });

// time.*
const timeNowOutput = z.object({ iso: z.string(), epochMs: z.number() });

const timeParseInput = z.object({ value: z.union([z.string(), z.number()]) });
const timeParseOutput = z.object({ iso: z.string(), epochMs: z.number() });

const timeFormatInput = z.object({
  value: z.union([z.string(), z.number()]),
  format: z.enum(["iso", "epoch", "epochSeconds", "utc", "rfc2822"]),
});
const timeFormatOutput = z.object({ value: z.union([z.string(), z.number()]) });

const timeDiffInput = z.object({
  a: z.union([z.string(), z.number()]),
  b: z.union([z.string(), z.number()]),
  unit: z.enum(["ms", "s", "m", "h", "d"]).optional(),
});
const timeDiffOutput = z.object({ value: z.number() });

const timeAddInput = z.object({
  value: z.union([z.string(), z.number()]),
  duration: z.string().min(1),
});
const timeAddOutput = z.object({ iso: z.string(), epochMs: z.number() });

// crypto.*
const cryptoSha256Input = z.object({ value: z.string() });
const cryptoSha256Output = z.object({ digest: z.string() });

const cryptoHmacInput = z.object({
  value: z.string(),
  secret: z.string().min(1),
  algorithm: z.enum(["sha256", "sha512"]).optional(),
});
const cryptoHmacOutput = z.object({ digest: z.string() });

const cryptoUuidOutput = z.object({ value: z.string() });

/* -------- pure helpers shared across the time / json / csv tools -------- */

const TIME_DIFF_UNIT_MS: Record<"ms" | "s" | "m" | "h" | "d", number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function createSafeRegex(pattern: string, flags?: string): RE2 {
  return new RE2(pattern, normalizeRegexFlags(flags));
}

function normalizeRegexFlags(flags?: string): string {
  const raw = flags ?? "g";
  if (!/^[gimsuy]*$/.test(raw)) {
    throw new Error("Unsupported regular expression flags; use only g, i, m, s, u, y");
  }
  const unique = new Set<string>();
  for (const flag of raw) {
    if (unique.has(flag)) {
      throw new Error(`Duplicate regular expression flag: ${flag}`);
    }
    unique.add(flag);
  }
  unique.add("u");
  return Array.from(unique).join("");
}

function toEpochMs(value: string | number): number {
  if (typeof value === "number") return Math.trunc(value);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid date/time: ${value}`);
  }
  return parsed;
}

// Path segments that target the prototype chain. Refusing them keeps a
// user-controlled path from injecting values that show up as inherited
// properties on the result object (or on objects downstream that consume
// it). Defense-in-depth — even though our spread-based copy avoids global
// `Object.prototype` mutation, leaving `.polluted` reachable via the
// prototype chain of the returned value is a footgun for callers.
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

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

function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const tools = {
  "http.request": defineTool({
    name: "http.request",
    description: "Make an HTTP request to an external API.",
    inputSchema: httpRequestInput,
    outputSchema: httpRequestOutput,
    inputExample: { url: "https://example.com", method: "GET" },
    async execute(input) {
      const res = await fetchHttpTarget(input.url, {
        method: input.method ?? "GET",
        headers: input.headers,
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
      });
      const body = await res.text();
      return { statusCode: res.status, ok: res.ok, body };
    },
  }),
  "text.uppercase": defineTool({
    name: "text.uppercase",
    description: "Convert text to uppercase.",
    inputSchema: textUppercaseInput,
    outputSchema: textUppercaseOutput,
    inputExample: { value: "hello" },
    async execute(input) {
      return { value: input.value.toUpperCase() };
    },
  }),
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

  /* -------- text.* -------- */

  "text.lowercase": defineTool({
    name: "text.lowercase",
    description: "Convert text to lowercase.",
    inputSchema: textValueInput,
    outputSchema: textValueOutput,
    inputExample: { value: "HELLO" },
    async execute(input) {
      return { value: input.value.toLowerCase() };
    },
  }),

  "text.trim": defineTool({
    name: "text.trim",
    description: "Trim leading and trailing whitespace from text.",
    inputSchema: textValueInput,
    outputSchema: textValueOutput,
    inputExample: { value: "  hello  " },
    async execute(input) {
      return { value: input.value.trim() };
    },
  }),

  "text.replace": defineTool({
    name: "text.replace",
    description: "Replace literal occurrences of a substring (all by default).",
    inputSchema: textReplaceInput,
    outputSchema: textValueOutput,
    inputExample: { value: "hello world", search: "world", replacement: "there" },
    async execute(input) {
      const all = input.all ?? true;
      return {
        value: all
          ? input.value.split(input.search).join(input.replacement)
          : input.value.replace(input.search, input.replacement),
      };
    },
  }),

  "text.regex": defineTool({
    name: "text.regex",
    description: "Match a regular expression against text and return capture groups.",
    inputSchema: textRegexInput,
    outputSchema: textRegexOutput,
    inputExample: { value: "user@example.com", pattern: "([^@]+)@(.+)", group: 1 },
    async execute(input) {
      const re = createSafeRegex(input.pattern, input.flags);
      const matches: string[] = [];
      const maxIterations = 1000; // Defense-in-depth against runaway patterns.
      if (re.global) {
        let count = 0;
        let m: ReturnType<RE2["exec"]>;
        while ((m = re.exec(input.value)) !== null) {
          if (count++ >= maxIterations) break;
          matches.push(input.group !== undefined ? (m[input.group] ?? "") : (m[0] ?? ""));
          if (m[0] === "") {
            re.lastIndex += 1;
          }
        }
      } else {
        const m = re.exec(input.value);
        if (m) matches.push(input.group !== undefined ? (m[input.group] ?? "") : (m[0] ?? ""));
      }
      return { matches };
    },
  }),

  /* -------- json.* -------- */

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

  /* -------- csv.* -------- */

  "csv.parse": defineTool({
    name: "csv.parse",
    description: "Parse a CSV string into rows. Default `hasHeader: true` returns objects keyed by header.",
    inputSchema: csvParseInput,
    outputSchema: csvParseOutput,
    inputExample: { value: "a,b\n1,2", hasHeader: true },
    async execute(input) {
      return { rows: parseCsv(input.value, input.hasHeader ?? true) };
    },
  }),

  "csv.stringify": defineTool({
    name: "csv.stringify",
    description: "Serialise rows to CSV. Provide `header` for object-rows; omit for array-rows.",
    inputSchema: csvStringifyInput,
    outputSchema: csvStringifyOutput,
    inputExample: { rows: [{ a: "1", b: "2" }], header: ["a", "b"] },
    async execute(input) {
      return { value: stringifyCsv(input.rows, input.header) };
    },
  }),

  "csv.filter": defineTool({
    name: "csv.filter",
    description: "Filter object-rows by an exact-match `where` map (every entry must match).",
    inputSchema: csvFilterInput,
    outputSchema: csvFilterOutput,
    inputExample: { rows: [{ id: "1", status: "open" }], where: { status: "open" } },
    async execute(input) {
      return { rows: filterCsv(input.rows, input.where) };
    },
  }),

  /* -------- time.* -------- */

  "time.now": defineTool({
    name: "time.now",
    description: "Return the current time as ISO + epoch milliseconds.",
    inputSchema: z.object({}),
    outputSchema: timeNowOutput,
    inputExample: {},
    async execute() {
      const epochMs = Date.now();
      return { iso: new Date(epochMs).toISOString(), epochMs };
    },
  }),

  "time.parse": defineTool({
    name: "time.parse",
    description: "Parse an ISO-8601 string or numeric epoch (ms) into both forms.",
    inputSchema: timeParseInput,
    outputSchema: timeParseOutput,
    inputExample: { value: "2026-01-01T00:00:00Z" },
    async execute(input) {
      const epochMs = toEpochMs(input.value);
      return { iso: new Date(epochMs).toISOString(), epochMs };
    },
  }),

  "time.format": defineTool({
    name: "time.format",
    description: "Format a time value in one of `iso`/`epoch`/`epochSeconds`/`utc`/`rfc2822`.",
    inputSchema: timeFormatInput,
    outputSchema: timeFormatOutput,
    inputExample: { value: "2026-01-01T00:00:00Z", format: "epoch" },
    async execute(input) {
      const epochMs = toEpochMs(input.value);
      const date = new Date(epochMs);
      switch (input.format) {
        case "iso":
          return { value: date.toISOString() };
        case "epoch":
          return { value: epochMs };
        case "epochSeconds":
          return { value: Math.trunc(epochMs / 1000) };
        case "utc":
          return { value: date.toUTCString() };
        case "rfc2822":
          return { value: date.toUTCString() };
      }
    },
  }),

  "time.diff": defineTool({
    name: "time.diff",
    description: "Compute b - a as a duration in `unit` (default ms).",
    inputSchema: timeDiffInput,
    outputSchema: timeDiffOutput,
    inputExample: { a: "2026-01-01T00:00:00Z", b: "2026-01-04T00:00:00Z", unit: "d" },
    async execute(input) {
      const diffMs = toEpochMs(input.b) - toEpochMs(input.a);
      const unit = input.unit ?? "ms";
      return { value: diffMs / TIME_DIFF_UNIT_MS[unit] };
    },
  }),

  "time.add": defineTool({
    name: "time.add",
    description: "Add an ISO 8601 duration (e.g. `P3D`, `PT2H30M`) to a time value.",
    inputSchema: timeAddInput,
    outputSchema: timeAddOutput,
    inputExample: { value: "2026-01-01T00:00:00Z", duration: "P3D" },
    async execute(input) {
      const baseMs = toEpochMs(input.value);
      const offsetMs = parseIsoDuration(input.duration);
      if (offsetMs === null) {
        throw new Error(`Invalid ISO 8601 duration: ${input.duration}`);
      }
      const epochMs = baseMs + offsetMs;
      return { iso: new Date(epochMs).toISOString(), epochMs };
    },
  }),

  /* -------- crypto.* -------- */

  "crypto.sha256": defineTool({
    name: "crypto.sha256",
    description: "Compute the SHA-256 digest of `value` (hex-encoded).",
    inputSchema: cryptoSha256Input,
    outputSchema: cryptoSha256Output,
    inputExample: { value: "hello" },
    async execute(input) {
      return { digest: createHash("sha256").update(input.value).digest("hex") };
    },
  }),

  "crypto.hmac": defineTool({
    name: "crypto.hmac",
    description: "Compute an HMAC of `value` with `secret` (default `sha256`, `sha512` allowed).",
    inputSchema: cryptoHmacInput,
    outputSchema: cryptoHmacOutput,
    inputExample: { value: "hello", secret: "topsecret" },
    async execute(input) {
      const algorithm = input.algorithm ?? "sha256";
      return { digest: createHmac(algorithm, input.secret).update(input.value).digest("hex") };
    },
  }),

  "crypto.uuid": defineTool({
    name: "crypto.uuid",
    description: "Generate a v4 UUID via the platform crypto random source.",
    inputSchema: z.object({}),
    outputSchema: cryptoUuidOutput,
    inputExample: {},
    async execute() {
      return { value: randomUUID() };
    },
  }),
} satisfies Record<string, ToolDefinition>;

type RegisteredTool = keyof typeof tools;

/**
 * Map a Zod issue to a flat string suitable for the public validation result.
 *
 * Preserves the legacy "Missing required input: <field>" wording that the AI
 * Studio + existing tests assert on, while still giving useful messages for
 * type errors and other non-presence failures.
 */
function formatIssue(issue: z.core.$ZodIssue): string {
  const path = issue.path.length ? issue.path.map(String).join(".") : "<root>";
  if (issue.code === "invalid_type") {
    // Zod 4 stores the actual received value only inside `issue.message`
    // (e.g. "Invalid input: expected string, received undefined") rather than
    // exposing it as a separate field. Detect the "missing required key" case
    // by looking for the `received undefined` suffix so the legacy
    // "Missing required input: <field>" wording survives — both the AI Studio
    // copy and the existing tests assert on it.
    if (typeof issue.message === "string" && issue.message.includes("received undefined")) {
      return `Missing required input: ${path}`;
    }
    const expected = (issue as unknown as { expected?: string }).expected;
    return `Invalid type for ${path}: expected ${expected ?? "valid value"}`;
  }
  if (issue.code === "too_small" && (issue as unknown as { minimum?: number }).minimum === 1) {
    return `Missing required input: ${path}`;
  }
  return `${path}: ${issue.message}`;
}

/**
 * Walk a `z.object` schema's shape to extract `required` and `optional` field
 * lists for `listTools`.
 *
 * Zod 4 exposes `.shape` as the field-name → ZodType map, and each field has
 * `.isOptional()`. The result is structurally identical to the legacy
 * `required`/`optional` arrays the web UI consumes.
 */
function describeShape(schema: z.ZodObject<z.ZodRawShape>): { required: string[]; optional: string[] } {
  const required: string[] = [];
  const optional: string[] = [];
  for (const [key, field] of Object.entries(schema.shape)) {
    if ((field as z.ZodTypeAny).isOptional()) optional.push(key);
    else required.push(key);
  }
  return { required, optional };
}

/**
 * Public list of registered tools, shaped for the AI Studio inspector.
 *
 * Called from `apps/api/src/index.ts` `GET /tools`. The JSON shape is part of
 * the contract `apps/web` consumes via `ToolSchema` in `apps/web/src/types.ts`
 * — the field names must stay stable.
 */
export function listTools(): ToolSchema[] {
  return Object.values(tools).map((tool) => {
    const { required, optional } = describeShape(tool.inputSchema as z.ZodObject<z.ZodRawShape>);
    return {
      name: tool.name,
      description: tool.description,
      required,
      optional: optional.length > 0 ? optional : undefined,
      inputExample: tool.inputExample,
    };
  });
}

/**
 * Validate a candidate input against the registered tool's input schema.
 *
 * Returns a `{ valid, issues }` shape so callers (including tests and the AI
 * Studio loose-mode pre-flight) can treat the result as a soft check before
 * committing to actually invoking the tool.
 *
 * @param name Tool identifier — must exist in the registry.
 * @param input Anything the agent planner emitted; may be `undefined`/`null`.
 */
export function validateToolInput(name: string, input: unknown): { valid: boolean; issues: string[] } {
  const tool = tools[name as RegisteredTool];
  if (!tool) {
    return { valid: false, issues: [`Unknown tool: ${name}`] };
  }
  const parsed = tool.inputSchema.safeParse(input ?? {});
  if (parsed.success) {
    return { valid: true, issues: [] };
  }
  return { valid: false, issues: parsed.error.issues.map(formatIssue) };
}

/**
 * Run a registered tool against a parsed input and the runtime context.
 *
 * Validates `input` against the tool's `inputSchema`, calls the executor with
 * the parsed (typed) value, then validates the result against `outputSchema`.
 * Any schema failure throws a descriptive `Error`; the runtime catches it at
 * the node-execution boundary and emits a `node.failed` event.
 *
 * Called from:
 * - `packages/engine/src/node-registry.ts` — agent-loop tool dispatch
 * - `packages/engine/src/node-registry.ts` — `tool` node executor
 *
 * @throws when the tool name is unregistered, the input fails the schema, or
 *         the executor returns a value that doesn't match the output schema.
 */
export async function executeTool(
  name: string,
  input: unknown,
  context: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tool = tools[name as RegisteredTool];
  if (!tool) {
    throw new Error(`Unknown tool: ${name}`);
  }

  const parsedInput = tool.inputSchema.safeParse(input ?? {});
  if (!parsedInput.success) {
    const issues = parsedInput.error.issues.map(formatIssue);
    throw new Error(`Invalid tool input for ${name}: ${issues.join(", ")}`);
  }

  // TS infers `tool` as a union of every registered ToolDefinition, which
  // means the executor's parameter type widens to the intersection of every
  // input shape — impossible to satisfy with one parsed value. The runtime
  // safety comes from `parsedInput` matching exactly this tool's schema, so
  // casting to the executor's expected shape is sound.
  const result = await (tool.execute as (input: unknown, context: Record<string, unknown>) => Promise<unknown>)(
    parsedInput.data,
    context,
  );

  // Output validation catches executor drift early. A misbehaving tool is a
  // bug, not user-facing input — so we throw with the issue list rather than
  // returning a partially-malformed object.
  const parsedOutput = tool.outputSchema.safeParse(result);
  if (!parsedOutput.success) {
    const issues = parsedOutput.error.issues.map(formatIssue);
    throw new Error(`Tool ${name} returned invalid output: ${issues.join(", ")}`);
  }

  return parsedOutput.data as Record<string, unknown>;
}
