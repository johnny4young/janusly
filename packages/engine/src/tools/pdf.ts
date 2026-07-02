/**
 * `pdf.generate` tool — render a Markdown/HTML template to PDF and upload it
 * to the org-scoped object store, with rate-limit gating + usage telemetry.
 *
 * Used by: `packages/engine/src/tool-registry.ts` (spreads `pdfTools`).
 */

import { z } from "zod";
import { RATE_LIMIT_WINDOW_MS } from "../constants";
import { getObjectStore } from "../object-store";
import { renderHtmlToPdf, renderMarkdownToPdf } from "../pdf-renderer";
import { getEngineRateLimiter } from "../rate-limit";
import { getPdfUsageRecorder } from "../pdf-usage";
import { defineTool, envPositiveInt, type ToolExecutionContext } from "./tool-types";

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

export const pdfTools = {
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
};
