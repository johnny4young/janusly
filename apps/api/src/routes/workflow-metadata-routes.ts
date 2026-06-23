/**
 * Per-workflow metadata routes — owners, runbook Markdown, description,
 * tags, Slack / Linear coordinates, and default severity.
 *
 * Routes:
 *   - `GET  /workflows/:id/metadata`    (viewer, workflows.read)
 *   - `POST /workflows/:id/metadata`    (editor, workflows.write)
 *   - `POST /workflows/:id/folder`      (editor, workflows.write)
 *   - `POST /workflows/folders/rename`  (editor, workflows.write) — bulk re-key folder=from → to
 *   - `POST /workflows/folders/delete`  (editor, workflows.write) — bulk move folder members to Ungrouped
 *   - `POST /workflows/folders/assign`  (editor, workflows.write) — bulk move listed workflows into a folder
 *
 * The `folders/*` collection routes operate in bulk (no per-workflow URL id), so
 * they validate the body and enforce org scope in the repo rather than calling
 * `assertWorkflowBelongsToOrg`. Rename/delete scope by `workflow_metadata.org_id`;
 * assign first filters requested ids through the org's `workflows` rows, then
 * upserts metadata for that owned subset. All three audit with affected ids.
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
 * Multi-tenant scope: per-workflow routes verify the workflow belongs to the
 * caller's org via the `workflows` table before touching metadata; collection
 * folder ops scope their bulk update by `workflow_metadata.org_id` in the repo.
 */

import { and, eq } from "drizzle-orm";
import { db, workflows } from "@janusly/db";
import {
  AssignWorkflowsToFolderBodySchema,
  DeleteWorkflowFolderBodySchema,
  RenameWorkflowFolderBodySchema,
  SetWorkflowFolderBodySchema,
  UpsertWorkflowMetadataBodySchema,
} from "@janusly/shared";
import {
  assignWorkflowsToFolder,
  deleteWorkflowFolder,
  getWorkflowMetadata,
  renameWorkflowFolder,
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

/** Match `/workflows/folders/rename` — the bulk folder-rename collection route. */
function matchFolderRenamePath(url: string): boolean {
  return (url.split("?")[0] ?? "") === "/workflows/folders/rename";
}

/** Match `/workflows/folders/delete` — the bulk folder-delete collection route. */
function matchFolderDeletePath(url: string): boolean {
  return (url.split("?")[0] ?? "") === "/workflows/folders/delete";
}

/** Match `/workflows/folders/assign` — the bulk folder-assign collection route. */
function matchFolderAssignPath(url: string): boolean {
  return (url.split("?")[0] ?? "") === "/workflows/folders/assign";
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
  // Folder-collection ops (exact matchers, placed first so they can't be
  // confused with the per-workflow `/:id/folder` | `/:id/metadata` matchers,
  // which require a 2-segment `<id>/folder` shape). Org-scoped in the repo.
  {
    method: "POST",
    match: matchFolderRenamePath,
    role: "editor",
    permission: "workflows.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = RenameWorkflowFolderBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(
          res,
          {
            error: "invalid folder rename body",
            code: "workflow_metadata_invalid",
            issues: parsed.error.issues.map((iss) => ({
              path: iss.path.join("."),
              message: iss.message,
            })),
          },
          422,
        );
      }

      const { from, to } = parsed.data;
      const { workflowIds } = await renameWorkflowFolder({ orgId: auth.orgId, from, to });

      await auditAction(auth, "workflow.folder.renamed", {
        targetType: "folder",
        targetId: to,
        metadata: { from, to, count: workflowIds.length, workflowIds },
      });

      return sendJson(res, { from, to, count: workflowIds.length, workflowIds });
    },
  },
  {
    method: "POST",
    match: matchFolderDeletePath,
    role: "editor",
    permission: "workflows.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = DeleteWorkflowFolderBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(
          res,
          {
            error: "invalid folder delete body",
            code: "workflow_metadata_invalid",
            issues: parsed.error.issues.map((iss) => ({
              path: iss.path.join("."),
              message: iss.message,
            })),
          },
          422,
        );
      }

      const { folder } = parsed.data;
      const { workflowIds } = await deleteWorkflowFolder({ orgId: auth.orgId, folder });

      await auditAction(auth, "workflow.folder.deleted", {
        targetType: "folder",
        targetId: folder,
        metadata: { folder, count: workflowIds.length, workflowIds },
      });

      return sendJson(res, { folder, count: workflowIds.length, workflowIds });
    },
  },
  {
    method: "POST",
    match: matchFolderAssignPath,
    role: "editor",
    permission: "workflows.write",
    handler: async ({ req, res, auth }) => {
      const body = asRecord(await readJson(req, MAX_JSON_BODY_BYTES));
      const parsed = AssignWorkflowsToFolderBodySchema.safeParse(body);
      if (!parsed.success) {
        return sendJson(
          res,
          {
            error: "invalid folder assign body",
            code: "workflow_metadata_invalid",
            issues: parsed.error.issues.map((iss) => ({
              path: iss.path.join("."),
              message: iss.message,
            })),
          },
          422,
        );
      }

      const { workflowIds: requestedIds, folder } = parsed.data;
      const { workflowIds } = await assignWorkflowsToFolder({
        orgId: auth.orgId,
        workflowIds: requestedIds,
        folder,
        actorUserId: auth.userId,
      });

      await auditAction(auth, "workflow.folder.bulk_assigned", {
        targetType: "folder",
        targetId: folder ?? "(ungrouped)",
        metadata: { folder, count: workflowIds.length, workflowIds },
      });

      return sendJson(res, { folder, count: workflowIds.length, workflowIds });
    },
  },
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
