/**
 * Per-workflow metadata routes — owners, runbook Markdown, description,
 * tags, Slack / Linear coordinates, and default severity.
 *
 * Three routes:
 *   - `GET  /workflows/:id/metadata`  (viewer, workflows.read)
 *   - `POST /workflows/:id/metadata`  (editor, workflows.write)
 *   - `POST /workflows/:id/folder`    (editor, workflows.write)
 *
 * The GET returns `{ metadata: WorkflowMetadataRecord | null }` — a
 * missing row is a 200 with `metadata: null` (not a 404) so the
 * operator's UI doesn't trip on first load.
 *
 * The metadata POST upserts the WHOLE row, writes a `workflow.metadata.set`
 * audit row with `{ before, after, workflowId }`, and bumps `updatedAt`. The
 * existing `audit()` chokepoint routes the metadata through
 * `safePersistPayload` so sensitive-keyed fields are redacted and the
 * audit row is size-bounded. Runbook free text is still persisted for
 * traceability; operators should not paste secrets into it.
 *
 * The folder POST is the NARROW sibling: it reassigns ONLY the `folder`
 * column (the Flows-list drag-to-folder path) via `setWorkflowFolder`, which
 * leaves owners / tags / runbook / Slack / Linear / severity untouched. It
 * audits the same `workflow.metadata.set` action with `{ before, after }`. A
 * naive full-metadata upsert from the Flows list (which only knows the row's
 * folder) would wipe every other field — this route exists to avoid that.
 *
 * Multi-tenant scope: both routes verify the workflow belongs to the
 * caller's org via `workflows` table lookup before touching the
 * metadata row.
 */

import { and, eq } from "drizzle-orm";
import { db, workflows } from "@janusly/db";
import { SetWorkflowFolderBodySchema, UpsertWorkflowMetadataBodySchema } from "@janusly/shared";
import {
  getWorkflowMetadata,
  setWorkflowFolder,
  upsertWorkflowMetadata,
} from "@janusly/data";

import { auditAction } from "../audit-helper";
import { MAX_JSON_BODY_BYTES } from "../api-config";
import { errorEnvelope } from "../error-codes";
import { asRecord, readJson, sendJson } from "../http";
import type { Route } from "../routes";

/** Match `/workflows/<id>/metadata` (no query string yet). Excludes `/workflows/...` reserved suffixes. */
function matchMetadataPath(url: string): boolean {
  if (!url.startsWith("/workflows/")) return false;
  const rest = url.slice("/workflows/".length).split("?")[0];
  const segments = rest.split("/");
  return segments.length === 2 && segments[1] === "metadata" && segments[0].length > 0;
}

function workflowIdFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  if (!path.startsWith("/workflows/")) return null;
  const rest = path.slice("/workflows/".length);
  const segments = rest.split("/");
  if (segments.length !== 2 || segments[1] !== "metadata") return null;
  return segments[0] || null;
}

/** Match `/workflows/<id>/folder` (the narrow folder-reassign route). */
function matchFolderPath(url: string): boolean {
  if (!url.startsWith("/workflows/")) return false;
  const rest = url.slice("/workflows/".length).split("?")[0];
  const segments = rest.split("/");
  return segments.length === 2 && segments[1] === "folder" && segments[0].length > 0;
}

function workflowIdFromFolderUrl(url: string | undefined): string | null {
  if (!url) return null;
  const path = url.split("?")[0] ?? "";
  if (!path.startsWith("/workflows/")) return null;
  const rest = path.slice("/workflows/".length);
  const segments = rest.split("/");
  if (segments.length !== 2 || segments[1] !== "folder") return null;
  return segments[0] || null;
}

async function assertWorkflowBelongsToOrg(
  orgId: string,
  workflowId: string,
): Promise<boolean> {
  const owned = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.orgId, orgId)))
    .limit(1);
  return owned.length > 0;
}

export const workflowMetadataRoutes: Route[] = [
  {
    method: "GET",
    match: matchMetadataPath,
    role: "viewer",
    permission: "workflows.read",
    handler: async ({ req, res, auth }) => {
      const workflowId = workflowIdFromUrl(req.url);
      if (!workflowId) return sendJson(res, { error: "workflowId required" }, 400);

      if (!(await assertWorkflowBelongsToOrg(auth.orgId, workflowId))) {
        return sendJson(res, errorEnvelope("workflow_not_found", "Workflow not found"), 404);
      }

      const metadata = await getWorkflowMetadata(auth.orgId, workflowId);
      return sendJson(res, { workflowId, metadata });
    },
  },
  {
    method: "POST",
    match: matchMetadataPath,
    role: "editor",
    permission: "workflows.write",
    handler: async ({ req, res, auth }) => {
      const workflowId = workflowIdFromUrl(req.url);
      if (!workflowId) return sendJson(res, { error: "workflowId required" }, 400);

      if (!(await assertWorkflowBelongsToOrg(auth.orgId, workflowId))) {
        return sendJson(res, errorEnvelope("workflow_not_found", "Workflow not found"), 404);
      }

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = UpsertWorkflowMetadataBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(
          res,
          {
            error: "invalid workflow metadata body",
            code: "workflow_metadata_invalid",
            issues: parsed.error.issues.map((iss) => ({
              path: iss.path.join("."),
              message: iss.message,
            })),
          },
          422,
        );
      }

      const { record, previous } = await upsertWorkflowMetadata({
        orgId: auth.orgId,
        workflowId,
        metadata: parsed.data.metadata,
        actorUserId: auth.userId,
      });

      await auditAction(auth, "workflow.metadata.set", { targetType: "workflow", targetId: workflowId, metadata: {
        before: previous,
        after: record,
        workflowId,
      } });

      return sendJson(res, { workflowId, metadata: record });
    },
  },
  {
    method: "POST",
    match: matchFolderPath,
    role: "editor",
    permission: "workflows.write",
    handler: async ({ req, res, auth }) => {
      const workflowId = workflowIdFromFolderUrl(req.url);
      if (!workflowId) return sendJson(res, { error: "workflowId required" }, 400);

      if (!(await assertWorkflowBelongsToOrg(auth.orgId, workflowId))) {
        return sendJson(res, errorEnvelope("workflow_not_found", "Workflow not found"), 404);
      }

      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = SetWorkflowFolderBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(
          res,
          {
            error: "invalid workflow folder body",
            code: "workflow_metadata_invalid",
            issues: parsed.error.issues.map((iss) => ({
              path: iss.path.join("."),
              message: iss.message,
            })),
          },
          422,
        );
      }

      const { record, previous } = await setWorkflowFolder({
        orgId: auth.orgId,
        workflowId,
        folder: parsed.data.folder,
        actorUserId: auth.userId,
      });

      await auditAction(auth, "workflow.metadata.set", { targetType: "workflow", targetId: workflowId, metadata: {
        before: previous,
        after: record,
        workflowId,
      } });

      return sendJson(res, { workflowId, metadata: record });
    },
  },
];
