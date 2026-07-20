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
 * - `apps/api/src/routes/tools-routes.ts` `GET /tools` — returns
 *   `listTools()` to the AI Studio for inspector rendering.
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
import {
  githubAddIssueCommentTool,
  githubCreateIssueTool,
  slackPostTool,
  webhookSendTool,
} from "./integration-tools";
import {
  dbQueryReadTool,
  dbQueryTransactionTool,
  dbQueryWriteTool,
  dbSchemaDescribeTool,
} from "./db-query-tools";
import { vectorSearchTool, vectorUpsertTool } from "./vector-tools";
import { defineTool, type ToolDefinition, type ToolExecutionContext } from "./tools/tool-types";
import { httpTools } from "./tools/http";
import { textTools } from "./tools/text";
import { jsonTools } from "./tools/json";
import { csvTools } from "./tools/csv";
import { timeTools } from "./tools/time";
import { cryptoTools } from "./tools/crypto";
import { pdfTools } from "./tools/pdf";
import { emailTools } from "./tools/email";

// `ToolExecutionContext` is re-exported here because sibling tool modules
// (`vector-tools.ts`, `db-query-tools.ts`, `integration-dispatch.ts`) import
// it from `./tool-registry` — keep that entry point stable.
export type { ToolExecutionContext };

/**
 * Public-facing tool metadata returned by `listTools()` for the AI Studio.
 *
 * Derived at runtime from each tool's Zod input schema (see `describeShape`),
 * so producers can't drift from consumers — change the schema and the JSON
 * shape updates automatically.
 *
 * `descriptionCode` is a stable derivation from `name` (`slack.post` →
 * `slack-post`) so the web layer can translate the description via the
 * i18n catalog under `tools.<descriptionCode>.description` and fall back
 * to the literal `description` (English) when no key exists yet.
 */
export type ToolSchema = {
  name: string;
  description: string;
  descriptionCode: string;
  required?: string[];
  optional?: string[];
  inputExample?: Record<string, unknown>;
};

/**
 * Planner-only projection of a registered tool.
 *
 * Unlike the stable public `ToolSchema`, this shape carries the input's JSON
 * Schema so the LLM sees field types and enum constraints instead of only
 * field names. It stays internal to the engine prompt and never expands the
 * `GET /tools` response consumed by the web app.
 */
export type PlannerToolSchema = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  writeSide: boolean;
};

/** Slugify a tool `name` (`slack.post` → `slack-post`) for catalog keys. */
export function toolDescriptionCode(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

const tools = {
  ...pdfTools,
  ...emailTools,
  ...httpTools,
  "slack.post": defineTool(slackPostTool),
  "github.create_issue": defineTool(githubCreateIssueTool),
  "github.add_issue_comment": defineTool(githubAddIssueCommentTool),
  "webhook.send": defineTool(webhookSendTool),
  "db.schema.describe": defineTool(dbSchemaDescribeTool),
  "db.query.read": defineTool(dbQueryReadTool),
  "db.query.write": defineTool(dbQueryWriteTool),
  "db.query.transaction": defineTool(dbQueryTransactionTool),
  "vector.search": defineTool(vectorSearchTool),
  "vector.upsert": defineTool(vectorUpsertTool),
  ...textTools,
  ...jsonTools,
  ...csvTools,
  ...timeTools,
  ...cryptoTools,
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
 * Called from `apps/api/src/routes/tools-routes.ts` and exposed as stable
 * `GET /v1/tools`. The JSON shape is part of the contract `apps/web` consumes
 * via `ToolSchema` in `apps/web/src/types.ts` — the field names must stay stable.
 */
export function listTools(): ToolSchema[] {
  return Object.values(tools).map((tool) => {
    const { required, optional } = describeShape(tool.inputSchema as z.ZodObject<z.ZodRawShape>);
    return {
      name: tool.name,
      description: tool.description,
      descriptionCode: toolDescriptionCode(tool.name),
      required,
      optional: optional.length > 0 ? optional : undefined,
      inputExample: tool.inputExample,
    };
  });
}

let plannerToolsCache: PlannerToolSchema[] | null = null;

/**
 * Return the registered tool catalog shaped for the agent-planner prompt.
 *
 * The catalog is derived from the same Zod schemas execution validates, then
 * cached because registration is process-static. Validation/sandbox planners
 * omit write-side tools before the model sees them; execution still retains
 * its independent dry-run gate as defense in depth.
 */
export function listPlannerTools(options: { dryRun?: boolean } = {}): PlannerToolSchema[] {
  if (!plannerToolsCache) {
    plannerToolsCache = Object.values(tools).map((tool) => {
      const { $schema: _schemaDialect, ...inputSchema } = z.toJSONSchema(tool.inputSchema);
      return {
        name: tool.name,
        description: tool.description,
        inputSchema: inputSchema as Record<string, unknown>,
        writeSide: tool.writeSide === true,
      };
    });
  }

  return options.dryRun
    ? plannerToolsCache.filter((tool) => !tool.writeSide)
    : plannerToolsCache;
}

export function isRegisteredTool(name: string): name is RegisteredTool {
  return name in tools;
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
/**
 * Whether a registered tool is flagged write-side (mutates external state)
 * and should be skipped in sandbox/validation runs. Returns `false` for
 * unknown names so a typo doesn't accidentally short-circuit tool calls.
 *
 * Note: for tools whose write-side intent depends on the input (e.g.
 * `http.request` only mutates on non-safe HTTP methods), the caller must
 * refine further by inspecting the input. This helper only reports the
 * registration-time flag.
 */
export function isToolWriteSide(name: string): boolean {
  const tool = tools[name as RegisteredTool];
  return tool?.writeSide === true;
}

export async function executeTool(
  name: string,
  input: unknown,
  context: Record<string, unknown>,
  executionContext: ToolExecutionContext = {},
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
  const result = await (tool.execute as (
    input: unknown,
    context: Record<string, unknown>,
    executionContext: ToolExecutionContext,
  ) => Promise<unknown>)(
    parsedInput.data,
    context,
    executionContext,
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
