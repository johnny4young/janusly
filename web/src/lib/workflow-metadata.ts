/** Metadata write-body contracts; the editor imports only its own shape validator. */
import * as z from 'zod/mini'
import {
  WorkflowMetadataSchema,
  WORKFLOW_METADATA_FOLDER_MAX_LENGTH,
  WORKFLOW_METADATA_TAG_MAX_LENGTH,
} from './workflow-metadata-schema'
export * from './workflow-metadata-schema'

/** Body of `POST /workflows/:id/metadata`. */
export const UpsertWorkflowMetadataBodySchema = /* @__PURE__ */ z.object({
  metadata: WorkflowMetadataSchema,
})

/**
 * Body of the narrow folder-only reassignment route (`POST /workflows/:id/folder`).
 *
 * `folder` is REQUIRED here (not `.optional()` like the field on
 * `WorkflowMetadataSchema`): a real name (1..60 chars) moves the workflow into
 * that folder; `null` removes it (back to "Ungrouped"). Unlike the full
 * metadata upsert, the write behind this body changes ONLY the `folder` column
 * and never touches owners / tags / runbook / Slack / Linear / severity — so a
 * drag-to-folder reassign from the Flows list (which only knows the row's
 * folder) can't clobber the rest of a workflow's metadata.
 */
export const SetWorkflowFolderBodySchema = /* @__PURE__ */ z.strictObject({
  folder: z.nullable(
    z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_FOLDER_MAX_LENGTH)),
  ),
})

/**
 * Body of the folder-rename collection route (`POST /workflows/folders/rename`).
 * Re-keys every workflow whose folder is `from` to `to` in one write. Both are
 * required real names (1..60 chars). If `to` already exists the members merge
 * into it — renaming into an existing folder is a deliberate merge, not an error.
 */
export const RenameWorkflowFolderBodySchema = /* @__PURE__ */ z.strictObject({
  from: z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_FOLDER_MAX_LENGTH)),
  to: z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_FOLDER_MAX_LENGTH)),
})

/**
 * Body of the folder-delete collection route (`POST /workflows/folders/delete`).
 * Moves every member of `folder` back to "Ungrouped" (sets `folder` null). The
 * workflows themselves are untouched — delete only clears the folder label.
 */
export const DeleteWorkflowFolderBodySchema = /* @__PURE__ */ z.strictObject({
  folder: z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_FOLDER_MAX_LENGTH)),
})

/**
 * Upper bound on a single bulk folder-assignment request. The Flows list caps at
 * 100/200 rows, so 500 is safe headroom while still bounding the IN-list size.
 */
export const WORKFLOW_BULK_ASSIGN_MAX = 500

/**
 * Body of the bulk folder-assign collection route (`POST /workflows/folders/assign`).
 * Moves every listed workflow into `folder` (a real name, possibly NEW) in one
 * write, or to "Ungrouped" when `folder` is null. Unlike rename/delete this
 * targets arbitrary workflows that may not have a metadata row yet, so the write
 * behind it upserts. `workflowIds` are validated against the caller's org server-side.
 */
export const AssignWorkflowsToFolderBodySchema = /* @__PURE__ */ z.strictObject({
  workflowIds: z
    .array(z.string().check(z.minLength(1)))
    .check(z.minLength(1), z.maxLength(WORKFLOW_BULK_ASSIGN_MAX)),
  folder: z.nullable(
    z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_FOLDER_MAX_LENGTH)),
  ),
})

/**
 * Body of the bulk tag-assign collection route (`POST /workflows/tags/assign`).
 * Adds or removes ONE `tag` across every listed workflow in a single write.
 * Unlike folder (a scalar, one per workflow), tags are a multi-value set, so
 * `op` picks the set operation: `'add'` unions the tag in (dedup, capped at
 * `WORKFLOW_METADATA_TAGS_MAX`), `'remove'` filters it out. A no-op per workflow
 * (already-present add / absent remove) is silently skipped server-side.
 * `workflowIds` are validated against the caller's org server-side.
 */
export const AssignTagToWorkflowsBodySchema = /* @__PURE__ */ z.strictObject({
  workflowIds: z
    .array(z.string().check(z.minLength(1)))
    .check(z.minLength(1), z.maxLength(WORKFLOW_BULK_ASSIGN_MAX)),
  tag: z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_TAG_MAX_LENGTH)),
  op: z.enum(['add', 'remove']),
})

/**
 * Body of the tag-rename collection route (`POST /workflows/tags/rename`).
 * Renames the `from` tag to `to` across EVERY workflow in the org that carries
 * it, in one write. If a workflow already has `to`, the two merge (the renamed
 * tag is deduped, never doubled) — rename-into-existing is a deliberate merge.
 */
export const RenameWorkflowTagBodySchema = /* @__PURE__ */ z.strictObject({
  from: z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_TAG_MAX_LENGTH)),
  to: z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_TAG_MAX_LENGTH)),
})

/**
 * Body of the tag-delete collection route (`POST /workflows/tags/delete`).
 * Strips `tag` from EVERY workflow in the org that carries it. The workflows
 * themselves are untouched — delete only removes the label, so it's reversible
 * by adding the tag back.
 */
export const DeleteWorkflowTagBodySchema = /* @__PURE__ */ z.strictObject({
  tag: z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_TAG_MAX_LENGTH)),
})

/**
 * Body of the narrow per-row tag route (`POST /workflows/:id/tags`). Adds or
 * removes ONE `tag` on the single workflow named in the URL — the inline
 * equivalent of the bulk assign for one row. `op` picks the set operation;
 * `add` is a dedup-safe union, `remove` filters the tag out.
 */
export const SetWorkflowTagBodySchema = /* @__PURE__ */ z.strictObject({
  tag: z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_TAG_MAX_LENGTH)),
  op: z.enum(['add', 'remove']),
})
