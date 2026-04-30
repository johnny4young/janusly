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
 *   pin from ENG-021 is preserved on every call.
 * - Adding a new tool without `inputSchema` and `outputSchema` is a TypeScript
 *   error thanks to the `satisfies Record<string, ToolDefinition>` constraint.
 */

import { z } from "zod";
import { getByPath } from "./template";
import { fetchHttpTarget } from "./http-policy";

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
