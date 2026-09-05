/**
 * Per-workflow metadata contract — owners, runbook Markdown, AI operator
 * guidance, description, tags, folder, Slack / Linear coordinates, and a
 * default severity for incidents spawned from the workflow.
 *
 * Pure, zero-I/O — safe to import from web bundle + engine + api + data.
 *
 * Used by:
 *  - Backend workflow metadata storage (read + upsert)
 *  - `internal/httpapi/workflowmetadata.go` (GET + POST)
 *  - `web/src/components/WorkflowMetadataPanel.tsx` (edit form)
 *  - `web/src/components/WorkflowAboutCard.tsx` (read-only display)
 *  - The recovery runtime (severity default)
 *  - `internal/httpapi/recoveryitems.go` (owner default on assign)
 *
 * Invariants:
 *  - `runbookMarkdown` is capped at 32 KiB of UTF-8 data so an
 *    unbounded paste cannot inflate the row or the audit metadata.
 *  - `aiGuidanceMarkdown` is capped at 8 KiB of UTF-8 data. It is an
 *    operator preference layer, never a secret store or a system-policy
 *    override; AI prompt composers scrub and frame it before use.
 *  - `slackChannel` MUST start with `#` and match the Slack channel-name
 *    grammar. Pasted channel ids (`channels/C12345`) are intentionally
 *    rejected with a clear message — v2 may add channel-id support.
 *  - `linearProject` accepts either a `https://linear.app/...` URL or a
 *    `workspace/project` slug. The web component normalizes the slug to
 *    a full URL at display time.
 *  - `severityDefault` reuses the closed `RECOVERY_ITEM_SEVERITIES` enum;
 *    no separate severity vocabulary lives here.
 *  - `folder` is a single flat organizing name (no nesting); null /
 *    absent means the workflow is ungrouped in the Flows list.
 */

import * as z from 'zod/mini'

import { RECOVERY_ITEM_SEVERITIES } from './recovery-item'
import {
  AI_OPERATOR_GUIDANCE_SCOPE_MAX_BYTES,
  containsOperatorGuidanceSecret,
} from './operator-guidance'
import { utf8ByteLength } from './utf8'

/** Runbook size cap (32 KiB by UTF-8 bytes). */
export const WORKFLOW_METADATA_RUNBOOK_MAX_BYTES = 32 * 1024

/** Per-workflow AI guidance cap (8 KiB by UTF-8 bytes). */
export const WORKFLOW_METADATA_AI_GUIDANCE_MAX_BYTES = AI_OPERATOR_GUIDANCE_SCOPE_MAX_BYTES

/** Maximum owner user ids per workflow. First entry is the primary owner. */
export const WORKFLOW_METADATA_OWNERS_MAX = 10

/** Maximum operator-supplied tags per workflow. */
export const WORKFLOW_METADATA_TAGS_MAX = 10

/** Maximum length of a single tag. Shared by the metadata schema and the bulk
 *  tag-assign body so the two bounds can't drift. */
export const WORKFLOW_METADATA_TAG_MAX_LENGTH = 40

/**
 * Maximum length of a workflow's folder name. A folder is the single
 * organizing home a workflow appears under in the Flows list (one folder
 * per workflow, flat — no nesting). Null / absent means "ungrouped".
 */
export const WORKFLOW_METADATA_FOLDER_MAX_LENGTH = 60

/** Slack channel must start with `#` (encourages copy-paste safety; avoids URL guessing). */
const SlackChannelSchema = /* @__PURE__ */ z.string().check(
  z.minLength(2),
  z.maxLength(80),
  // Total length = `#` + 1 first char + up to 78 trailing chars = 2..80,
  // matching the outer `.max(80)` so the two bounds agree and a 81-char
  // string can never partially pass the regex before the outer length
  // cap rejects it with a confusing error message.
  z.regex(/^#[a-z0-9][a-z0-9._-]{0,78}$/i, 'slack channel must start with `#`'),
)

/** Linear project: either a full URL or a `<workspace>/<project>` slug. */
const LinearProjectSchema = /* @__PURE__ */ z.string().check(
  z.minLength(3),
  z.maxLength(200),
  z.refine(
    (v) =>
      v.startsWith('https://linear.app/') || /^[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(v),
    'linear project must be a linear.app URL or `workspace/project` slug',
  ),
)

/** Closed-key partial-update schema. Every field is optional / nullable. */
export const WorkflowMetadataSchema = /* @__PURE__ */ z.strictObject({
    owners: z._default(
      z
        .array(z.string().check(z.minLength(1), z.maxLength(200)))
        .check(z.maxLength(WORKFLOW_METADATA_OWNERS_MAX)),
      [],
    ),
    runbookMarkdown: z.optional(
      z.nullable(
        z.string().check(
          z.refine(
        (value) => utf8ByteLength(value) <= WORKFLOW_METADATA_RUNBOOK_MAX_BYTES,
        'runbook exceeds 32 KiB cap',
          ),
        ),
      ),
    ),
    aiGuidanceMarkdown: z.optional(
      z.nullable(
        z.string().check(
          z.refine(
        (value) => utf8ByteLength(value) <= WORKFLOW_METADATA_AI_GUIDANCE_MAX_BYTES,
        'AI guidance exceeds 8 KiB cap',
          ),
          z.refine(
        (value) => !containsOperatorGuidanceSecret(value),
        'AI guidance must not contain secret-like values',
          ),
        ),
      ),
    ),
    description: z.optional(z.nullable(z.string().check(z.maxLength(2000)))),
    tags: z._default(
      z
        .array(z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_TAG_MAX_LENGTH)))
        .check(z.maxLength(WORKFLOW_METADATA_TAGS_MAX)),
      [],
    ),
    folder: z.optional(
      z.nullable(
        z.string().check(z.minLength(1), z.maxLength(WORKFLOW_METADATA_FOLDER_MAX_LENGTH)),
      ),
    ),
    slackChannel: z.optional(z.nullable(SlackChannelSchema)),
    linearProject: z.optional(z.nullable(LinearProjectSchema)),
    severityDefault: z.optional(z.nullable(z.enum(RECOVERY_ITEM_SEVERITIES))),
  })

export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>

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

/** Hydrated row shape returned by the data repo + the GET route. */
export type WorkflowMetadataRecord = WorkflowMetadata & {
  workflowId: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
}
