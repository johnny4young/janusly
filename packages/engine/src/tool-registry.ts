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
import { scrubSecretShapes } from "@janusly/shared/src/error-signature";
import { RATE_LIMIT_WINDOW_MS } from "./constants";
import { getByPath } from "./template";
import { consumeStreamToPreview, fetchHttpTarget } from "./http-policy";
import { streamCsvSummary } from "./csv-stream";
import { filterCsv, parseCsv, stringifyCsv } from "./csv";
import { parseIsoDuration } from "./iso-duration";
import { evaluateJsonJq, parseJsonJqQuery } from "./json-jq";
import { getMailer } from "./mailer";
import { getObjectStore } from "./object-store";
import { renderHtmlToPdf, renderMarkdownToPdf } from "./pdf-renderer";
import { getEngineRateLimiter } from "./rate-limit";
import { getEmailUsageRecorder } from "./email-usage";
import { getPdfUsageRecorder } from "./pdf-usage";
import {
  githubAddIssueCommentTool,
  githubCreateIssueTool,
  slackPostTool,
  webhookSendTool,
} from "./integration-tools";

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

/** Slugify a tool `name` (`slack.post` → `slack-post`) for catalog keys. */
export function toolDescriptionCode(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Internal definition shape for one registered tool.
 *
 * `TIn`/`TOut` are inferred at the call site — registering a tool with literal
 * `z.object({...})` schemas gives the executor a fully-typed `input` and a
 * type-checked `Promise<output>`.
 */
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
  // Optional bounds — total request budget in ms, max decoded body size in
  // bytes, max redirect chain length. Defaults (30000 / 1_000_000 / 5) apply
  // when omitted; recipes that legitimately need larger payloads or slower
  // upstreams opt in per call.
  timeoutMs: z.number().int().min(1).optional(),
  maxResponseBytes: z.number().int().min(1).optional(),
  maxRedirects: z.number().int().min(0).optional(),
  /**
   * Body handling. `"buffer"` (default) returns the decoded response as a
   * `body: string` capped by `maxResponseBytes`. `"stream"` opts the call
   * into the streaming primitive — the tool wrapper internally consumes
   * the stream into a bounded preview before returning, so the persisted
   * tool output stays JSON-safe. The byte cap still applies (the
   * underlying stream aborts at the cap), and `streamPreviewBytes` controls
   * how much of the response the wrapper captures into the persisted
   * preview (default tenant config).
   */
  bodyMode: z.enum(["buffer", "stream"]).optional(),
  /** Preview cap in bytes when `bodyMode: "stream"`. Range 1024..1048576, falls back to the tenant's `http.streamPreviewBytes` default when omitted. */
  streamPreviewBytes: z.number().int().min(1_024).max(1_048_576).optional(),
});
const httpRequestOutput = z.object({
  statusCode: z.number(),
  ok: z.boolean(),
  body: z.string(),
  /** True iff the call ran with `bodyMode: "stream"`; `body` is then a preview, not the full response. */
  streamed: z.boolean().optional(),
  /** Total bytes consumed from the upstream stream (capped by `maxResponseBytes`). */
  streamedBytes: z.number().optional(),
  /** True iff `streamedBytes > streamPreviewBytes` (i.e. `body` is a truncated slice). */
  streamTruncated: z.boolean().optional(),
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

// csv.fetch — streaming variant. Fetches a CSV URL via the streaming
// HTTP primitive, consumes the body row-by-row, applies an optional
// exact-match filter, returns a bounded summary (counts + sample). The
// shared `maxResponseBytes` cap on the upstream stream still applies —
// when hit, the partial sample + counts ride through with
// `streamTruncated: true` so the operator sees what got through.
const csvFetchInput = z.object({
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  /** Max number of matched rows to retain in the response sample. Default 50, hard cap 500 (memory bound). */
  sampleRows: z.number().int().min(1).max(500).optional(),
  /** Optional exact-match WHERE clause; same shape `csv.filter` already uses. */
  filter: z.record(z.string(), z.string()).optional(),
  /** Max bytes pulled from the upstream stream. Default 10 MB; hard cap 50 MB. The shared `fetchHttpTarget` cap fires at this boundary. */
  maxBytes: z.number().int().min(1_024).max(52_428_800).optional(),
  /** Total HTTP timeout budget in ms. Range 1000..120000. */
  timeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  /** Max redirect chain length. 0..5. */
  maxRedirects: z.number().int().min(0).max(5).optional(),
});
const csvFetchOutput = z.object({
  ok: z.boolean(),
  /** HTTP status from the upstream response. `0` when the call never opened (SSRF / DNS / cap pre-check). */
  statusCode: z.number().int().nonnegative(),
  /** Total data rows seen (excludes the header row). Includes filtered-out + malformed. */
  totalRows: z.number().int().nonnegative(),
  /** Rows that passed the filter (or `=== totalRows` when no filter). Excludes malformed. */
  matchedRows: z.number().int().nonnegative(),
  /** First `min(sampleRows, matchedRows)` matched rows, keyed by header. */
  sampleRows: z.array(z.record(z.string(), z.string())),
  /** Header tokens in upstream order. `[]` when the stream produced zero rows. */
  headers: z.array(z.string()),
  /** Total bytes pulled from the upstream stream (capped by `maxBytes`). */
  streamedBytes: z.number().int().nonnegative(),
  /**
   * True iff the stream OPENED and then aborted before clean end (byte
   * cap exceeded mid-stream, decoder error, network blip). False on
   * pre-stream rejection paths (SSRF / DNS pin / Content-Length pre-check)
   * — those return `ok: false` with `streamTruncated: false` because no
   * stream was ever opened. Downstream `condition` nodes that need to
   * distinguish "rejected before open" from "aborted mid-flight" should
   * branch on `(ok === false && streamedBytes > 0)` for the mid-flight
   * case, or `(ok === false && statusCode === 0)` for pre-stream.
   */
  streamTruncated: z.boolean(),
  /** Rows whose column count didn't match the header. Counted toward totalRows, not matchedRows. */
  malformedRows: z.number().int().nonnegative(),
  /** Present iff `ok: false`. Generic message; never echoes the upstream URL. */
  error: z.string().optional(),
});

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

/**
 * Build the per-org-prefixed object-store key for a `pdf.generate` upload.
 * Format: `orgs/<orgId>/pdfs/[<runId>/[<nodeId>/]]<filename>`. The runId
 * + nodeId path segments are skipped when missing (ad-hoc paths) so the
 * key stays stable but doesn't carry literal `undefined` strings.
 */
function buildPdfObjectKey(args: {
  orgId: string;
  runId?: string;
  nodeId?: string;
  filename: string;
}): string {
  const segments = ["orgs", encodeKeySegment(args.orgId), "pdfs"];
  if (args.runId) segments.push(encodeKeySegment(args.runId));
  if (args.nodeId) segments.push(encodeKeySegment(args.nodeId));
  segments.push(encodeKeySegment(args.filename));
  return segments.join("/");
}

function encodeKeySegment(raw: string): string {
  // Object stores accept arbitrary characters but URLs do not — we keep
  // letters / digits / `.`, `_`, `-` literal and percent-encode anything
  // else. Filenames already pass the regex in the input schema; this is
  // defense for runId/nodeId, which can be any application-supplied id.
  return raw.replace(/[^A-Za-z0-9._-]/g, (ch) => encodeURIComponent(ch));
}

function envPositiveInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}

/**
 * Fires the registered email-usage recorder, swallowing any failure so
 * a recorder bug can't break the `email.send` tool path. Skipped when
 * no recorder is registered (unit tests).
 */
async function fireEmailRecorder(input: {
  orgId: string;
  executionContext: ToolExecutionContext;
  to: string;
  from: string;
  provider: "resend" | "sendgrid" | "noop";
  providerMessageId?: string;
  ok: boolean;
  error?: string;
  latencyMs: number;
}): Promise<void> {
  const recorder = getEmailUsageRecorder();
  if (!recorder) return;
  try {
    await recorder({
      orgId: input.orgId,
      runId: input.executionContext.runId,
      nodeId: input.executionContext.nodeId,
      workflowId: input.executionContext.workflowId,
      to: input.to,
      from: input.from,
      provider: input.provider,
      providerMessageId: input.providerMessageId,
      ok: input.ok,
      error: input.error,
      latencyMs: input.latencyMs,
    });
  } catch {
    // Telemetry must never break the tool. Drop silently.
  }
}

const emailSendInput = z.object({
  /** Recipient email address. v1 ships single-recipient only; multi-to lands when the AC asks. */
  to: z.string().min(1),
  /**
   * Sender email address. When omitted, the tool falls back to
   * `process.env.JANUSLY_MAILER_FROM` at execute time. Resend's
   * sandbox sender is `onboarding@resend.dev`; SendGrid requires a
   * DNS-verified domain.
   */
  from: z.string().min(1).optional(),
  /** Subject line. Capped at RFC 5322's 998-char line length. */
  subject: z.string().min(1).max(998),
  /** Plain-text body. Required when `html` is not supplied. */
  text: z.string().max(200_000).optional(),
  /** HTML body. Required when `text` is not supplied. */
  html: z.string().max(500_000).optional(),
  /**
   * Provider metadata: Resend `tags`, SendGrid `custom_args`. Kept
   * intentionally small because it is copied into outbound provider
   * payloads and billing telemetry.
   */
  metadata: z.record(z.string().min(1).max(64), z.string().max(256))
    .refine((value) => Object.keys(value).length <= 20, {
      message: "email.send metadata supports at most 20 entries",
    })
    .optional(),
}).refine(
  (input) => Boolean(input.text || input.html),
  { message: "email.send requires `text` or `html` (or both)." },
);

const emailSendOutput = z.object({
  /** True iff the provider accepted the email for delivery. */
  ok: z.boolean(),
  /** Which mailer handled the call. `"noop"` when no API key was configured. */
  provider: z.enum(["resend", "sendgrid", "noop"]),
  /** Provider-assigned id; populated on success. */
  providerMessageId: z.string().optional(),
  /** Failure reason; populated when `ok === false`. Mirrors the AGENTS.md AI-fallback contract for write-side tools. */
  error: z.string().optional(),
});

/**
 * Fires the registered pdf-usage recorder, swallowing any failure so a
 * recorder bug can't break the `pdf.generate` tool path. Skipped when
 * no recorder is registered (unit tests).
 */
async function firePdfRecorder(input: {
  orgId: string;
  executionContext: ToolExecutionContext;
  provider: "s3" | "local" | "noop";
  key?: string;
  contentLength: number;
  ok: boolean;
  error?: string;
  latencyMs: number;
}): Promise<void> {
  const recorder = getPdfUsageRecorder();
  if (!recorder) return;
  try {
    await recorder({
      orgId: input.orgId,
      runId: input.executionContext.runId,
      nodeId: input.executionContext.nodeId,
      workflowId: input.executionContext.workflowId,
      provider: input.provider,
      key: input.key,
      contentLength: input.contentLength,
      ok: input.ok,
      error: input.error,
      latencyMs: input.latencyMs,
    });
  } catch {
    // Telemetry must never break the tool. Drop silently.
  }
}

const pdfGenerateInput = z.object({
  /**
   * Template source. The dialect is controlled by `format` (default
   * `"markdown"`). `{{name}}` placeholders are substituted from the
   * `variables` map BEFORE parsing in both dialects.
   *
   * - Markdown: heading levels 1-3, paragraphs with bold (`**…**`) /
   *   italic (`*…*`), bulleted + numbered lists, fenced code blocks
   *   (```` ``` ````), and `---` horizontal rules.
   * - HTML: a sanitized subset parsed via `htmlparser2`. Whitelist covers
   *   `<h1>`-`<h6>`, `<p>`, `<div>`, `<br>`, `<ul>`, `<ol>`, `<li>`, `<hr>`,
   *   `<pre>`, `<code>`, `<strong>`/`<b>`, `<em>`/`<i>`, `<span>`,
   *   `<a href>` (http/https only), and `<table>`/`<thead>`/`<tbody>`/`<tr>`/
   *   `<th>`/`<td>` (with bounded `colspan`). `<script>`, `<style>`,
   *   `<iframe>`, `<object>`, `<embed>`, `<link>`, `<meta>`, `<base>`,
   *   `<form>`, `<input>`, `<img>`, `<svg>` and all `on*` attributes are
   *   dropped silently.
   */
  template: z.string().min(1).max(200_000),
  /**
   * Template dialect. Defaults to `"markdown"` for backward compatibility
   * — every existing call site continues working without code changes.
   */
  format: z.enum(["markdown", "html"]).default("markdown"),
  /**
   * Optional `{{name}}` substitutions. Coerced to strings at render
   * time. Unknown placeholders are left intact in the rendered PDF so
   * operators spot template typos immediately.
   */
  variables: z
    .record(z.string().min(1).max(64), z.union([z.string(), z.number(), z.boolean()]))
    .refine((value) => Object.keys(value).length <= 100, {
      message: "pdf.generate variables supports at most 100 entries",
    })
    .optional(),
  /**
   * Optional output filename. Sanitized to a single safe path segment.
   * Defaults to `<nodeId>.pdf` (or `pdf.pdf` when nodeId is absent).
   */
  filename: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9._-]+$/, { message: "filename may only contain letters, digits, '.', '_', '-'" })
    .optional(),
  /** PDF document title written to the file's metadata. */
  title: z.string().min(1).max(240).optional(),
});

const pdfGenerateOutput = z.object({
  /** True iff the PDF was rendered AND uploaded to the object store. */
  ok: z.boolean(),
  /** Object-store provider that handled the upload. `"noop"` when unconfigured. */
  provider: z.enum(["s3", "local", "noop"]),
  /** Downloadable URL — public or presigned, depending on the provider config. */
  url: z.string().optional(),
  /** Per-org-prefixed object key (e.g. `orgs/org-1/pdfs/run-1/node-1/invoice.pdf`). */
  key: z.string().optional(),
  /** Produced PDF size in bytes. */
  contentLength: z.number().optional(),
  /** Failure reason; populated when `ok === false`. Mirrors the AGENTS.md AI-fallback contract for write-side tools. */
  error: z.string().optional(),
  /** Wall-clock latency from the tool's POV (ms). */
  latencyMs: z.number(),
});

const tools = {
  "pdf.generate": defineTool({
    name: "pdf.generate",
    description: "Render a Markdown or HTML template into a PDF and upload it to the configured object store.",
    inputSchema: pdfGenerateInput,
    outputSchema: pdfGenerateOutput,
    inputExample: {
      format: "markdown",
      template: "# Invoice {{number}}\n\nAmount: **{{amount}}**",
      variables: { number: "INV-001", amount: "$100.00" },
      filename: "invoice.pdf",
    },
    writeSide: true,
    async execute(input, _context, executionContext) {
      const start = Date.now();
      const orgId = executionContext.orgId;
      const providerOverride = executionContext.objectstore?.provider;
      // Used in usage rows for failure paths that exit before the upload
      // call resolves — prefer the configured provider over a misleading
      // "noop" so dashboard breakdowns attribute the failure correctly.
      const declaredProvider = (providerOverride
        ?? process.env.JANUSLY_OBJECT_STORE_PROVIDER
        ?? "noop").toLowerCase() as "s3" | "local" | "noop";
      const knownProvider: "s3" | "local" | "noop" =
        declaredProvider === "s3" || declaredProvider === "local" ? declaredProvider : "noop";
      const rateLimitPerMin =
        executionContext.integrations?.pdf?.rateLimitPerMin
        ?? envPositiveInt("JANUSLY_PDF_RATE_LIMIT_PER_MIN", 30);

      // Per-org key prefix is the only thing keeping tenants from reading
      // each other's PDFs. Refuse to proceed without an orgId rather than
      // falling back to a shared "_anonymous" prefix.
      if (!orgId) {
        const latencyMs = Date.now() - start;
        return {
          ok: false,
          provider: knownProvider,
          error: "pdf.generate requires multi-tenant context (orgId)",
          latencyMs,
        };
      }

      // Per-org rate gate. Render is more expensive than a Slack post
      // (CPU + outbound PUT), so we gate BEFORE the render to save work
      // when over limit. The injected limiter throws when over limit;
      // the wrapper converts to `{ ok: false, error }` for the AI-
      // fallback contract.
      const limiter = getEngineRateLimiter();
      if (limiter) {
        try {
          await limiter("tool.pdf.generate", orgId, { windowMs: RATE_LIMIT_WINDOW_MS, max: rateLimitPerMin });
        } catch (err) {
          const error = err instanceof Error ? err.message : "Rate limit exceeded";
          const latencyMs = Date.now() - start;
          await firePdfRecorder({
            orgId,
            executionContext,
            provider: knownProvider,
            contentLength: 0,
            ok: false,
            error,
            latencyMs,
          });
          return { ok: false, provider: knownProvider, error, latencyMs };
        }
      }

      let pdfBuffer: Buffer;
      let contentLength = 0;
      try {
        const renderer = input.format === "html" ? renderHtmlToPdf : renderMarkdownToPdf;
        const result = await renderer({
          template: input.template,
          variables: input.variables,
          title: input.title,
        });
        pdfBuffer = result.buffer;
        contentLength = result.contentLength;
      } catch (err) {
        const error = err instanceof Error ? err.message : "pdf render failed";
        const latencyMs = Date.now() - start;
        await firePdfRecorder({
          orgId,
          executionContext,
          provider: knownProvider,
          contentLength: 0,
          ok: false,
          error,
          latencyMs,
        });
        return { ok: false, provider: knownProvider, error, latencyMs };
      }

      const filename = input.filename
        ?? `${executionContext.nodeId ?? "pdf"}.pdf`;
      const key = buildPdfObjectKey({
        orgId,
        runId: executionContext.runId,
        nodeId: executionContext.nodeId,
        filename,
      });

      const store = getObjectStore(providerOverride);
      const upload = await store.put({ key, body: pdfBuffer, contentType: "application/pdf" });
      const latencyMs = Date.now() - start;

      await firePdfRecorder({
        orgId,
        executionContext,
        provider: upload.provider,
        key: upload.ok ? upload.key : undefined,
        contentLength,
        ok: upload.ok,
        error: upload.ok ? undefined : upload.error,
        latencyMs,
      });

      if (upload.ok) {
        return {
          ok: true,
          provider: upload.provider,
          url: upload.url,
          key: upload.key,
          contentLength,
          latencyMs,
        };
      }
      return { ok: false, provider: upload.provider, error: upload.error, latencyMs };
    },
  }),
  "email.send": defineTool({
    name: "email.send",
    description: "Send a transactional email via the configured mailer (Resend or SendGrid).",
    inputSchema: emailSendInput,
    outputSchema: emailSendOutput,
    inputExample: { to: "user@example.com", subject: "Hello", text: "Body of the email." },
    writeSide: true,
    async execute(input, _context, executionContext) {
      const start = Date.now();
      const orgId = executionContext.orgId;
      const limiter = getEngineRateLimiter();
      const rateLimitPerMin = executionContext.email?.rateLimitPerMin
        ?? envPositiveInt("JANUSLY_EMAIL_RATE_LIMIT_PER_MIN", 100);

      // Per-org rate gate. The injected limiter throws when over
      // limit; the tool wrapper converts the throw to a clean
      // `{ ok: false, error }` envelope so the AI-fallback contract
      // holds and the workflow run doesn't fail.
      if (orgId && limiter) {
        try {
          await limiter("email.send", orgId, { windowMs: RATE_LIMIT_WINDOW_MS, max: rateLimitPerMin });
        } catch (err) {
          const error = err instanceof Error ? err.message : "Rate limit exceeded";
          await fireEmailRecorder({
            orgId,
            executionContext,
            to: input.to,
            from: input.from ?? executionContext.email?.from ?? process.env.JANUSLY_MAILER_FROM ?? "onboarding@resend.dev",
            provider: "noop",
            ok: false,
            error,
            latencyMs: Date.now() - start,
          });
          return { ok: false, provider: "noop" as const, error };
        }
      }

      const from = input.from ?? executionContext.email?.from ?? process.env.JANUSLY_MAILER_FROM ?? "onboarding@resend.dev";
      const mailer = getMailer(executionContext.email?.provider);
      const result = await mailer.send({
        to: input.to,
        from,
        subject: input.subject,
        text: input.text,
        html: input.html,
        metadata: input.metadata,
      });
      const latencyMs = Date.now() - start;

      // Best-effort audit row. Wrapped in try/catch inside the helper
      // so a recorder failure can't break the tool path. Skipped when
      // there's no orgId (unit tests, ad-hoc paths).
      if (orgId) {
        await fireEmailRecorder({
          orgId,
          executionContext,
          to: input.to,
          from,
          provider: result.provider,
          providerMessageId: result.ok ? result.providerMessageId : undefined,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          latencyMs,
        });
      }

      if (result.ok) {
        return { ok: true, provider: result.provider, providerMessageId: result.providerMessageId };
      }
      return { ok: false, provider: result.provider, error: result.error };
    },
  }),
  /**
   * Invariant (AGENTS.md "HTTP/SSRF"): `http.request` must use
   * `fetchHttpTarget`, whose pinned undici Agent prevents DNS rebinding.
   * A direct `fetch()` bypasses SSRF protection for untrusted URLs.
   */
  "http.request": defineTool({
    name: "http.request",
    description: "Make an HTTP request to an external API.",
    inputSchema: httpRequestInput,
    outputSchema: httpRequestOutput,
    inputExample: { url: "https://example.com", method: "GET" },
    writeSide: true,
    async execute(input) {
      if (input.bodyMode === "stream") {
        const previewCap = input.streamPreviewBytes
          ?? envPositiveInt("JANUSLY_HTTP_STREAM_PREVIEW_BYTES", 65_536);
        const streaming = await fetchHttpTarget(input.url, {
          method: input.method ?? "GET",
          headers: input.headers,
          body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
          timeoutMs: input.timeoutMs,
          maxResponseBytes: input.maxResponseBytes,
          maxRedirects: input.maxRedirects,
          bodyMode: "stream",
        });
        // Always consume the stream — the byte cap fires inside the stream
        // regardless of whether the caller reads it, so draining here keeps
        // the cap-exceeded error reachable AND avoids leaking a live
        // ReadableStream out of the tool's JSON-safe envelope.
        const { preview, originalBytes, truncated } = await consumeStreamToPreview(streaming.body, previewCap);
        return {
          statusCode: streaming.statusCode,
          ok: streaming.ok,
          body: preview,
          streamed: true,
          streamedBytes: originalBytes,
          streamTruncated: truncated,
        };
      }
      const result = await fetchHttpTarget(input.url, {
        method: input.method ?? "GET",
        headers: input.headers,
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
        timeoutMs: input.timeoutMs,
        maxResponseBytes: input.maxResponseBytes,
        maxRedirects: input.maxRedirects,
      });
      return { statusCode: result.statusCode, ok: result.ok, body: result.body };
    },
  }),
  "slack.post": defineTool(slackPostTool),
  "github.create_issue": defineTool(githubCreateIssueTool),
  "github.add_issue_comment": defineTool(githubAddIssueCommentTool),
  "webhook.send": defineTool(webhookSendTool),
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

  "csv.fetch": defineTool({
    name: "csv.fetch",
    description: "Stream a CSV URL row-by-row and return a bounded summary (counts + sample). Use this for multi-MB CSV payloads instead of `http.request` + `csv.parse` — memory stays O(sampleRows).",
    inputSchema: csvFetchInput,
    outputSchema: csvFetchOutput,
    inputExample: { url: "https://example.com/data.csv", sampleRows: 10 },
    // Pure read — no remote mutation. Dry-run sandbox replays exercise
    // this identically to a production run.
    async execute(input) {
      const sampleCap = input.sampleRows ?? 50;
      const maxBytes = input.maxBytes ?? 10 * 1024 * 1024;
      // Outer try/catch turns the SSRF / DNS / pre-check failures
      // (which throw before any stream opens) into a clean
      // `{ ok: false, statusCode: 0 }` envelope. The stream-level
      // failures (mid-stream byte-cap abort, decoder error) flow
      // through `streamCsvSummary`'s catch and surface as
      // `{ ok: false, streamTruncated: true, ... }` with partial counts.
      try {
        const streaming = await fetchHttpTarget(input.url, {
          method: "GET",
          headers: input.headers,
          timeoutMs: input.timeoutMs,
          maxResponseBytes: maxBytes,
          maxRedirects: input.maxRedirects,
          bodyMode: "stream",
        });
        // Even when the response is non-2xx, the body is still streamed
        // (an error payload could be a CSV-shaped error response).
        // Surface the statusCode on the envelope so downstream
        // `condition` nodes can branch on it.
        const summary = await streamCsvSummary(streaming.body, {
          sampleRows: sampleCap,
          filter: input.filter,
        });
        const ok = summary.ok && streaming.ok;
        return {
          ok,
          statusCode: streaming.statusCode,
          totalRows: summary.totalRows,
          matchedRows: summary.matchedRows,
          sampleRows: summary.sampleRows,
          headers: summary.headers,
          streamedBytes: summary.streamedBytes,
          streamTruncated: summary.streamTruncated,
          malformedRows: summary.malformedRows,
          error: summary.error ?? (ok ? undefined : `HTTP ${streaming.statusCode}`),
        };
      } catch (err) {
        // Pre-stream rejection (SSRF / DNS pin / Content-Length cap /
        // unsupported scheme). Return a uniform error envelope so the
        // workflow can branch on `.ok` regardless of which guard fired.
        const message = err instanceof Error ? err.message : "csv fetch failed";
        return {
          ok: false,
          statusCode: 0,
          totalRows: 0,
          matchedRows: 0,
          sampleRows: [],
          headers: [],
          streamedBytes: 0,
          streamTruncated: false,
          malformedRows: 0,
          error: scrubSecretShapes(message).slice(0, 200),
        };
      }
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
      descriptionCode: toolDescriptionCode(tool.name),
      required,
      optional: optional.length > 0 ? optional : undefined,
      inputExample: tool.inputExample,
    };
  });
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
