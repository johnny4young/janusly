/**
 * Recovery incident handoff contracts — closed-enum destinations, Zod
 * request body + per-destination superRefine, deterministic message
 * composer.
 *
 * One handoff dispatch routes the full incident context (severity,
 * owner, error signature, recent comments, deep link) to the team's
 * coordination channel via the existing tool chokepoints
 * (`slack.post` / `github.create_issue` / `github.add_issue_comment` /
 * `webhook.send`). Idempotency keyed by `(orgId, recoveryItemId,
 * destination)` lives on the `recovery_item_handoffs` table and the
 * route's dispatcher branches per-destination (slack cooldown, github
 * create→comment, linear/webhook idempotencyKey header).
 *
 * Pure, zero-I/O — safe to import from web bundle + engine + api + data.
 */

import { z } from 'zod'

import { scrubSecretShapes } from './error-signature'

// ---------- destinations ----------

export const RECOVERY_HANDOFF_DESTINATIONS = ['slack', 'linear', 'github', 'webhook'] as const
export const RecoveryHandoffDestinationSchema = z.enum(RECOVERY_HANDOFF_DESTINATIONS)
export type RecoveryHandoffDestination = z.infer<typeof RecoveryHandoffDestinationSchema>

// ---------- request body ----------

/**
 * Per-destination required-field validation via `superRefine` (same shape
 * as `deliverRequestSchema` in `reports-routes.ts`). The closed set of
 * fields is `destination` + `credentialName` + per-destination extras
 * (`owner`/`repo`/`labels` for github; `url` for webhook/linear; `channel`
 * optional for slack).
 */
export const HandoffRequestBodySchema = z
  .object({
    destination: RecoveryHandoffDestinationSchema,
    credentialName: z.string().min(1).max(200),
    // GitHub-only fields (validated as required via superRefine below).
    owner: z.string().min(1).max(120).optional(),
    repo: z.string().min(1).max(120).optional(),
    labels: z.array(z.string().min(1).max(60)).max(10).optional(),
    assignees: z.array(z.string().min(1).max(60)).max(10).optional(),
    // Webhook / Linear: destination URL (required via superRefine).
    url: z.string().url().max(2048).optional(),
    // Slack-only optional channel override (most operators leave it null
    // because incoming webhooks are channel-bound at credential time).
    channel: z.string().min(1).max(120).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.destination === 'github' && (!value.owner || !value.repo)) {
      ctx.addIssue({
        code: 'custom',
        message: 'github destination requires owner + repo',
        path: ['owner'],
      })
    }
    if ((value.destination === 'webhook' || value.destination === 'linear') && !value.url) {
      ctx.addIssue({
        code: 'custom',
        message: `${value.destination} destination requires url`,
        path: ['url'],
      })
    }
  })

export type HandoffRequestBody = z.infer<typeof HandoffRequestBodySchema>

// ---------- dispatch outcomes ----------

export const HANDOFF_OUTCOMES = ['delivered', 'delivery_failed'] as const
export const HandoffOutcomeSchema = z.enum(HANDOFF_OUTCOMES)
export type HandoffOutcome = z.infer<typeof HandoffOutcomeSchema>

/**
 * Result envelope from the per-destination dispatch helper. Never thrown —
 * `ok: false` carries the upstream error message verbatim (scrubbed for
 * secret shapes by the dispatcher before persistence).
 */
export const HandoffDispatchResultSchema = z
  .object({
    destination: RecoveryHandoffDestinationSchema,
    ok: z.boolean(),
    statusCode: z.number().int().min(100).max(599).nullable().optional(),
    error: z.string().max(1000).nullable().optional(),
    latencyMs: z.number().int().min(0),
    externalId: z.string().max(200).nullable().optional(),
    externalUrl: z
      .string()
      .url()
      .max(2048)
      .refine((v) => /^https?:\/\//i.test(v), { message: "externalUrl must be http(s)" })
      .nullable()
      .optional(),
    /** Set on the second-call append branch for GitHub (commentId, etc). */
    commentId: z.string().max(200).nullable().optional(),
  })
  .strict()

export type HandoffDispatchResult = z.infer<typeof HandoffDispatchResultSchema>

// ---------- idempotency key ----------

/**
 * Stable, deterministic key passed both as the unique-index column and as
 * the `X-Idempotency-Key` header on webhook deliveries. The receiver can
 * dedupe by this value.
 */
export function buildHandoffIdempotencyKey(
  recoveryItemId: string,
  destination: RecoveryHandoffDestination,
): string {
  return `${recoveryItemId}:${destination}`
}

// ---------- slack cooldown ----------

/**
 * Default Slack cooldown window: 60 minutes. v1 = post-only (no Slack Web
 * API for threading), so the second-call branch responds 200 with
 * `alreadyDispatched: true` instead of re-posting and spamming the team
 * channel.
 */
export const SLACK_HANDOFF_COOLDOWN_SECONDS = 60 * 60

/** Returns true when the previous Slack dispatch is still inside the cooldown window. */
export function isSlackHandoffCoolingDown(
  lastDispatchedAtIso: string | Date,
  now: Date = new Date(),
  cooldownSeconds: number = SLACK_HANDOFF_COOLDOWN_SECONDS,
): boolean {
  const last = typeof lastDispatchedAtIso === 'string'
    ? new Date(lastDispatchedAtIso).getTime()
    : lastDispatchedAtIso.getTime()
  if (Number.isNaN(last)) return false
  const elapsed = (now.getTime() - last) / 1_000
  return elapsed < cooldownSeconds
}

// ---------- message composer ----------

export const HANDOFF_MESSAGE_FIELD_MAX = 400

export type HandoffMessageInput = {
  recoveryItemId: string
  deadLetterId: string
  workflowId?: string | null
  workflowName?: string | null
  runId?: string | null
  nodeId?: string | null
  errorSignature?: string | null
  severity: string
  status: string
  owner?: string | null
  slaTargetAtIso?: string | null
  recentComments?: Array<{ authorUserId: string; body: string; createdAt: string }>
  recoveryCenterUrl?: string | null
  /** Set when called for the GitHub second-call append branch. */
  appendMode?: boolean
  dispatchCount?: number
}

export type HandoffMessage = {
  /** Short single-line title — used as Slack header, GitHub issue title, email subject. */
  subject: string
  /** Markdown body — used by Slack `text`, GitHub issue body, GitHub comment body. */
  markdown: string
  /** Structured envelope — used as the webhook JSON body. */
  structured: {
    recoveryItemId: string
    deadLetterId: string
    workflowId: string | null
    workflowName: string | null
    runId: string | null
    nodeId: string | null
    errorSignature: string | null
    severity: string
    status: string
    owner: string | null
    slaTargetAtIso: string | null
    recoveryCenterUrl: string | null
    appendMode: boolean
    dispatchCount: number
    dispatchedAtIso: string
  }
}

function fmtField(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') {
    const scrubbed = scrubSecretShapes(value)
    return scrubbed.length > HANDOFF_MESSAGE_FIELD_MAX
      ? `${scrubbed.slice(0, HANDOFF_MESSAGE_FIELD_MAX)}…`
      : scrubbed
  }
  return String(value)
}

/** Deterministic Markdown template — NOT a prompt, NOT an LLM call. */
export function composeHandoffMessage(input: HandoffMessageInput): HandoffMessage {
  const appendMode = Boolean(input.appendMode)
  const dispatchCount = input.dispatchCount ?? (appendMode ? 2 : 1)
  const titlePrefix = appendMode ? 'Update' : 'Incident'
  const subject = `[Janusly] ${titlePrefix} — ${input.severity.toUpperCase()} ${input.workflowName ?? input.workflowId ?? '(ad-hoc workflow)'}`

  const lines: string[] = []
  if (appendMode) {
    lines.push(`**Recovery item update** (dispatch #${dispatchCount})`)
  } else {
    lines.push(`**${subject}**`)
  }
  lines.push('')
  lines.push(`- **Severity**: ${fmtField(input.severity.toUpperCase())}`)
  lines.push(`- **Status**: ${fmtField(input.status)}`)
  lines.push(`- **Owner**: ${fmtField(input.owner)}`)
  if (input.workflowId || input.workflowName) {
    lines.push(`- **Workflow**: ${fmtField(input.workflowName ?? input.workflowId)}`)
  }
  if (input.runId) lines.push(`- **Run**: ${fmtField(input.runId)}`)
  if (input.nodeId) lines.push(`- **Node**: ${fmtField(input.nodeId)}`)
  if (input.errorSignature) lines.push(`- **Error**: ${fmtField(input.errorSignature)}`)
  if (input.slaTargetAtIso) lines.push(`- **SLA target**: ${fmtField(input.slaTargetAtIso)}`)

  if (input.recentComments && input.recentComments.length > 0) {
    lines.push('')
    lines.push('**Recent comments**:')
    for (const comment of input.recentComments.slice(0, 3)) {
      lines.push(`> _${fmtField(comment.authorUserId)} — ${fmtField(comment.createdAt)}_`)
      lines.push(`> ${fmtField(comment.body)}`)
    }
  }

  if (input.recoveryCenterUrl) {
    lines.push('')
    lines.push(`[Open Recovery Center](${input.recoveryCenterUrl})`)
  }

  const markdown = lines.join('\n').trim()

  return {
    subject,
    markdown,
    structured: {
      recoveryItemId: input.recoveryItemId,
      deadLetterId: input.deadLetterId,
      workflowId: input.workflowId ?? null,
      workflowName: input.workflowName ?? null,
      runId: input.runId ?? null,
      nodeId: input.nodeId ?? null,
      errorSignature: input.errorSignature ?? null,
      severity: input.severity,
      status: input.status,
      owner: input.owner ?? null,
      slaTargetAtIso: input.slaTargetAtIso ?? null,
      recoveryCenterUrl: input.recoveryCenterUrl ?? null,
      appendMode,
      dispatchCount,
      dispatchedAtIso: new Date().toISOString(),
    },
  }
}
