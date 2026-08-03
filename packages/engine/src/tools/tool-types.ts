/**
 * Shared tool-registry framework types + helpers, factored out so per-domain
 * tool modules can depend on them without importing `tool-registry.ts` (which
 * would create an import cycle — the registry imports the domain modules).
 *
 * Used by:
 * - `packages/engine/src/tool-registry.ts` — imports `defineTool` /
 *   `ToolDefinition` / `ToolExecutionContext` and re-exports the context type.
 * - `packages/engine/src/tools/*.ts` — every domain module imports
 *   `defineTool` (and the shared `envPositiveInt` helper) from here.
 */

import { z } from "zod";

/**
 * Per-call execution context carrying engine-side identity bits that
 * write-side tools need (rate-limit + usage-record attribution). Pure
 * read-side tools (text / json / csv / time / crypto / json.pick)
 * ignore the field. Optional throughout so unit tests can call
 * `executeTool(name, input, context)` without threading mocks.
 */
export type ToolExecutionContext = {
  orgId?: string;
  runId?: string;
  nodeId?: string;
  workflowId?: string;
  /**
   * Present only for explicitly qualified local validation effects. Provider
   * adapters use it to isolate simulator state from production-scoped local
   * effects; it never enables arbitrary outbound calls.
   */
  providerSimulation?: {
    scope: "validation";
  };
  email?: {
    provider?: string;
    from?: string;
    rateLimitPerMin?: number;
  };
  /**
   * Per-tenant overrides for integration tool rate limits. Tools read
   * their relevant slice (`integrations.slack.rateLimitPerMin` etc.)
   * with an env-fallback when this is unset, so unit tests can exercise
   * the tool without threading the full snapshot.
   */
  integrations?: {
    slack?: { rateLimitPerMin?: number };
    github?: { rateLimitPerMin?: number };
    webhook?: { rateLimitPerMin?: number };
    pdf?: { rateLimitPerMin?: number };
    db?: { rateLimitPerMin?: number };
  };
  /**
   * Per-tenant overrides for the object-store that backs `pdf.generate`.
   * Empty when the tenant relies on env defaults — the resolver in
   * `object-store.ts` falls back to `JANUSLY_OBJECT_STORE_*` env keys.
   */
  objectstore?: {
    provider?: string;
  };
};

/**
 * Internal definition shape for one registered tool.
 *
 * `TIn`/`TOut` are inferred at the call site — every tool input is an object so
 * the public catalog and planner can derive named fields from the same schema.
 * Registering a literal `z.object({...})` gives the executor a fully-typed
 * `input` and a type-checked `Promise<output>`.
 */
export type ToolDefinition<
  TIn extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
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
    executionContext: ToolExecutionContext,
  ) => Promise<z.infer<TOut>>;
  /**
   * True when this tool can mutate external state and should be skipped
   * in sandbox/validation runs (`runs.replayMode === "validation"`,
   * surfaced as `NodeContext.dryRun`). The tool node executor checks
   * this flag before invoking the tool and, for invocations where the
   * write-side intent depends on the input (e.g. `http.request` only
   * mutates on non-safe HTTP methods), refines further before deciding
   * whether to skip. Pure transformation tools (text / json / csv /
   * time / crypto) leave this unset.
   */
  writeSide?: boolean;
};

/**
 * Identity helper that exists purely so TypeScript infers `TIn`/`TOut` from
 * the literal schema values when registering a tool. Without it the registry
 * would widen `execute`'s `input` to `unknown` under the `satisfies` clause.
 */
export function defineTool<TIn extends z.ZodObject<z.ZodRawShape>, TOut extends z.ZodTypeAny>(
  def: ToolDefinition<TIn, TOut>,
): ToolDefinition<TIn, TOut> {
  return def;
}

/**
 * Read a positive-integer env var with a fallback. Shared by the write-side
 * tools that gate on env-configured rate limits / preview caps
 * (`pdf.generate`, `email.send`, `http.request`).
 */
export function envPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}
