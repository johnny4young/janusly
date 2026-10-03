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

import { RECOVERY_ITEM_SEVERITIES } from './recovery-item-values'
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

