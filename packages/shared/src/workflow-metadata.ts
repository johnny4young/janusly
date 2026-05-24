/**
 * Per-workflow metadata contract — owners, runbook Markdown, description,
 * tags, Slack / Linear coordinates, and a default severity for incidents
 * spawned from the workflow.
 *
 * Pure, zero-I/O — safe to import from web bundle + engine + api + data.
 *
 * Used by:
 *  - `packages/data/src/workflowMetadataRepo.ts` (read + upsert)
 *  - `apps/api/src/routes/workflow-metadata-routes.ts` (GET + POST)
 *  - `apps/web/src/components/WorkflowMetadataPanel.tsx` (edit form)
 *  - `apps/web/src/components/WorkflowAboutCard.tsx` (read-only display)
 *  - `packages/engine/src/recovery/recovery-item-hook.ts` (severity default)
 *  - `apps/api/src/routes/recovery-items-routes.ts` (owner default on assign)
 *
 * Invariants:
 *  - `runbookMarkdown` is capped at 32 KiB of UTF-8 data so an
 *    unbounded paste cannot inflate the row or the audit metadata.
 *  - `slackChannel` MUST start with `#` and match the Slack channel-name
 *    grammar. Pasted channel ids (`channels/C12345`) are intentionally
 *    rejected with a clear message — v2 may add channel-id support.
 *  - `linearProject` accepts either a `https://linear.app/...` URL or a
 *    `workspace/project` slug. The web component normalizes the slug to
 *    a full URL at display time.
 *  - `severityDefault` reuses the closed `RECOVERY_ITEM_SEVERITIES` enum;
 *    no separate severity vocabulary lives here.
 */

import { z } from 'zod'

import { RECOVERY_ITEM_SEVERITIES } from './recovery-item'

/** Runbook size cap (32 KiB by UTF-8 bytes). */
export const WORKFLOW_METADATA_RUNBOOK_MAX_BYTES = 32 * 1024

/** Maximum owner user ids per workflow. First entry is the primary owner. */
export const WORKFLOW_METADATA_OWNERS_MAX = 10

/** Maximum operator-supplied tags per workflow. */
export const WORKFLOW_METADATA_TAGS_MAX = 10

/** Slack channel must start with `#` (encourages copy-paste safety; avoids URL guessing). */
const SlackChannelSchema = z
  .string()
  .min(2)
  .max(80)
  // Total length = `#` + 1 first char + up to 78 trailing chars = 2..80,
  // matching the outer `.max(80)` so the two bounds agree and a 81-char
  // string can never partially pass the regex before the outer length
  // cap rejects it with a confusing error message.
  .regex(/^#[a-z0-9][a-z0-9._-]{0,78}$/i, 'slack channel must start with `#`')

/** Linear project: either a full URL or a `<workspace>/<project>` slug. */
const LinearProjectSchema = z
  .string()
  .min(3)
  .max(200)
  .refine(
    (v) =>
      v.startsWith('https://linear.app/') || /^[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(v),
    'linear project must be a linear.app URL or `workspace/project` slug',
  )

const utf8Encoder = new TextEncoder()

function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength
}

/** Closed-key partial-update schema. Every field is optional / nullable. */
export const WorkflowMetadataSchema = z
  .object({
    owners: z
      .array(z.string().min(1).max(200))
      .max(WORKFLOW_METADATA_OWNERS_MAX)
      .default([]),
    runbookMarkdown: z
      .string()
      .refine(
        (value) => utf8ByteLength(value) <= WORKFLOW_METADATA_RUNBOOK_MAX_BYTES,
        'runbook exceeds 32 KiB cap',
      )
      .nullable()
      .optional(),
    description: z.string().max(2000).nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(WORKFLOW_METADATA_TAGS_MAX).default([]),
    slackChannel: SlackChannelSchema.nullable().optional(),
    linearProject: LinearProjectSchema.nullable().optional(),
    severityDefault: z.enum(RECOVERY_ITEM_SEVERITIES).nullable().optional(),
  })
  .strict()

export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>

/** Body of `POST /workflows/:id/metadata`. */
export const UpsertWorkflowMetadataBodySchema = z.object({
  metadata: WorkflowMetadataSchema,
})

export type UpsertWorkflowMetadataBody = z.infer<typeof UpsertWorkflowMetadataBodySchema>

/** Hydrated row shape returned by the data repo + the GET route. */
export type WorkflowMetadataRecord = WorkflowMetadata & {
  workflowId: string
  createdBy: string | null
  createdAt: string
  updatedAt: string
}
