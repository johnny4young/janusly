/**
 * Eval datasets — admin CRUD + JSONL export for the regression bed built
 * from operator-approved recovery decisions.
 *
 * Four routes registered into the global `routes: Route[]` registry:
 *
 *   - `GET    /eval/datasets`            — list paginated      (viewer, evals.read)
 *   - `POST   /eval/datasets`           — create + pull examples (admin, evals.write)
 *   - `GET    /eval/datasets/:id`       — single dataset       (viewer, evals.read)
 *   - `GET    /eval/datasets/:id/export?format=jsonl|json` — examples export (viewer, evals.read)
 *   - `DELETE /eval/datasets/:id`       — hard-delete + examples (admin, evals.write)
 *
 * Build-time eligibility (the opt-in gate) lives in
 * `queryEligibleFeedbackForEval`: a `recovery_feedback` row is pulled
 * ONLY when `accepted = true AND eval_consent = true`. No consent → not
 * eligible, full stop.
 *
 * Secret-shape scrubbing runs at write time (the data repo, when the
 * example is built) AND again at read time (the shared
 * `toEvalExampleJsonlRow` / `serializeEvalExamplesToJsonl`) — defense in
 * depth. When examples are surfaced to an LLM they go through
 * `composeEvalExamplePrompt`, which frames them as data (never
 * instructions) with the same suspicion-framing block the MCP
 * tool-exposure composer uses.
 *
 * Multi-tenant scope enforced by the repo (`eq(evalDatasets.orgId,
 * orgId)` / `eq(evalExamples.orgId, orgId)`).
 */

import { z } from "zod";
import {
  createEvalDataset,
  deleteEvalDataset,
  findEvalDatasetByName,
  getEvalDataset,
  listEvalDatasets,
  listEvalExamples,
} from "@janusly/data";
import { serializeEvalExamplesToJsonl } from "@janusly/shared/src/eval-dataset";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { asRecord, corsHeaders, readJson, sendError, sendJson } from "../http";
import {
  buildReportFilename,
  contentDispositionAttachment,
} from "../report-download";
import type { Route } from "../routes";

/** Zod body for `POST /eval/datasets`. Name + optional scope/retention/description. */
const CreateEvalDatasetBodySchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).optional(),
  /** Optional workflow scope; when set, only that workflow's eligible feedback is pulled. */
  workflowId: z.string().min(1).max(256).optional(),
  /** Retention window in days; omitted = indefinite. Clamped to [1, 3650] in the repo. */
  retentionDays: z.number().int().positive().max(3650).optional(),
});

function datasetIdFromUrl(url: string | undefined, suffix?: string): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  const re = suffix
    ? new RegExp(`^\\/eval\\/datasets\\/([^/?]+)\\/${suffix}$`)
    : /^\/eval\/datasets\/([^/?]+)$/;
  const m = path.match(re);
  return m ? m[1]! : null;
}

export const evalDatasetsRoutes: Route[] = [
  // GET /eval/datasets — list the org's datasets, newest first.
  {
    method: "GET",
    match: (url) => url === "/eval/datasets" || url.startsWith("/eval/datasets?"),
    role: "viewer",
    permission: "evals.read",
    handler: async ({ res, auth }) => {
      const datasets = await listEvalDatasets(auth.orgId);
      return sendJson(res, { datasets });
    },
  },

  // POST /eval/datasets — create a dataset and snapshot its examples from
  // the eligible (accepted + opted-in) recovery feedback.
  {
    method: "POST",
    match: (url) => url === "/eval/datasets" || url.startsWith("/eval/datasets?"),
    role: "admin",
    permission: "evals.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = CreateEvalDatasetBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendError(res, "eval_dataset_name_required", "Invalid eval dataset body", 400);
      }

      // Reject a duplicate name up-front for a clean 409 instead of a raw 23505.
      const existing = await findEvalDatasetByName(auth.orgId, parsed.data.name);
      if (existing) {
        return sendError(res, "eval_dataset_name_exists", "An eval dataset with that name already exists", 409, {
          name: parsed.data.name,
        });
      }

      const result = await createEvalDataset({
        orgId: auth.orgId,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        workflowId: parsed.data.workflowId ?? null,
        retentionDays: parsed.data.retentionDays ?? null,
        createdBy: auth.userId,
      });

      await auditAction(auth, "eval.dataset.created", {
        targetType: "eval-dataset",
        targetId: result.dataset.id,
        metadata: {
          name: result.dataset.name,
          workflowId: result.dataset.workflowId,
          exampleCount: result.exampleCount,
          retentionDays: result.dataset.retentionDays,
        },
      });

      return sendJson(res, { dataset: result.dataset }, 201);
    },
  },

  // GET /eval/datasets/:id/export?format=jsonl|json — download the
  // dataset's examples. JSONL (default) is one scrubbed object per line
  // for an eval harness; JSON returns the array. Examples are re-scrubbed
  // at read time by the shared serializer.
  {
    method: "GET",
    match: (url) => /^\/eval\/datasets\/[^/?]+\/export$/.test(url.split("?")[0] ?? ""),
    role: "viewer",
    permission: "evals.read",
    handler: async ({ req, res, auth }) => {
      const id = datasetIdFromUrl(req.url, "export");
      if (!id) return sendJson(res, { error: "id required" }, 400);

      const url = new URL(req.url ?? "", "http://internal");
      const formatRaw = (url.searchParams.get("format") ?? "jsonl").toLowerCase();
      if (formatRaw !== "jsonl" && formatRaw !== "json") {
        return sendJson(res, { error: `Unknown format: ${formatRaw}. Use "jsonl" or "json".` }, 400);
      }

      const dataset = await getEvalDataset(auth.orgId, id);
      if (!dataset) {
        return sendError(res, "eval_dataset_not_found", "Eval dataset not found", 404);
      }
      const examples = await listEvalExamples(auth.orgId, id);

      await auditAction(auth, "eval.dataset.exported", {
        targetType: "eval-dataset",
        targetId: id,
        metadata: { name: dataset.name, format: formatRaw, exampleCount: examples.length },
      });

      const { asciiFilename, utf8Filename } = buildReportFilename({
        runId: id,
        workflowName: `evals-${dataset.name}`,
        status: `examples-${examples.length}`,
        createdAt: dataset.createdAt,
        // The filename helper only knows md/json; jsonl rides the json branch
        // and we override the extension below.
        format: "json",
      });

      if (formatRaw === "json") {
        // Re-scrub at read time via the shared serializer's row projection.
        const rows = serializeEvalExamplesToJsonl(examples)
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line) as unknown);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Disposition": contentDispositionAttachment(asciiFilename, utf8Filename),
          "Access-Control-Expose-Headers": "Content-Disposition",
          ...corsHeaders(res),
        });
        res.end(JSON.stringify({ dataset, examples: rows }));
        return;
      }

      const jsonl = serializeEvalExamplesToJsonl(examples);
      const jsonlAscii = asciiFilename.replace(/\.json$/, ".jsonl");
      const jsonlUtf8 = utf8Filename.replace(/\.json$/, ".jsonl");
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": contentDispositionAttachment(jsonlAscii, jsonlUtf8),
        "Access-Control-Expose-Headers": "Content-Disposition",
        ...corsHeaders(res),
      });
      res.end(jsonl);
    },
  },

  // GET /eval/datasets/:id — single dataset metadata + its examples.
  {
    method: "GET",
    match: (url) => /^\/eval\/datasets\/[^/?]+$/.test(url.split("?")[0] ?? ""),
    role: "viewer",
    permission: "evals.read",
    handler: async ({ req, res, auth }) => {
      const id = datasetIdFromUrl(req.url);
      if (!id) return sendJson(res, { error: "id required" }, 400);

      const dataset = await getEvalDataset(auth.orgId, id);
      if (!dataset) {
        return sendError(res, "eval_dataset_not_found", "Eval dataset not found", 404);
      }
      // Re-scrub at read time: the shared serializer projects each example
      // through `toEvalExampleJsonlRow` (which re-runs `scrubSecretShapes`).
      const examples = serializeEvalExamplesToJsonl(await listEvalExamples(auth.orgId, id))
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown);
      return sendJson(res, { dataset, examples });
    },
  },

  // DELETE /eval/datasets/:id — hard-delete the dataset + its examples.
  {
    method: "DELETE",
    match: (url) => /^\/eval\/datasets\/[^/?]+$/.test(url.split("?")[0] ?? ""),
    role: "admin",
    permission: "evals.write",
    handler: async ({ req, res, auth }) => {
      const id = datasetIdFromUrl(req.url);
      if (!id) return sendJson(res, { error: "id required" }, 400);

      const deleted = await deleteEvalDataset(auth.orgId, id);
      if (!deleted) {
        return sendError(res, "eval_dataset_not_found", "Eval dataset not found", 404);
      }

      await auditAction(auth, "eval.dataset.deleted", {
        targetType: "eval-dataset",
        targetId: id,
      });

      return sendJson(res, { ok: true });
    },
  },
];
