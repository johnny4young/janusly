/**
 * Deterministic Markdown renderer for alert dispatch payloads. Same helper
 * feeds all four channel destinations (`slack.post` flattens Markdown to
 * `mrkdwn`, GitHub uses it verbatim as the issue body, webhook receives it
 * as the `markdown` field next to the structured payload, email uses it as
 * the plain-text body).
 *
 * NOT a prompt and NOT an LLM call — `composeAlertMessage` is a pure
 * template. The `triggerPayload` passes through `scrubSecretShapes` at the
 * dispatcher layer BEFORE this helper sees it (defense-in-depth above the
 * `safePersistPayload` redaction that ran when the source event was
 * recorded).
 */

import { scrubSecretShapes } from './error-signature'
import type { AlertTrigger } from './alert-policy'

export type AlertMessageInput = {
  policyName: string
  trigger: AlertTrigger
  triggerPayload: Record<string, unknown>
  recoveryCenterUrl?: string
}

export type AlertMessage = {
  /** Short single-line title — used as Slack header, GitHub issue title, email subject. */
  subject: string
  /** Markdown body — used by Slack `text`, GitHub issue body, email plain body. */
  markdown: string
  /** Structured envelope — used as the webhook JSON body. */
  structured: {
    policyName: string
    trigger: AlertTrigger
    payload: Record<string, unknown>
    recoveryCenterUrl: string | null
    dispatchedAtIso: string
  }
}

const MAX_FIELD_VALUE_LEN = 400

function formatPayloadValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'string') {
    const scrubbed = scrubSecretShapes(value)
    return scrubbed.length > MAX_FIELD_VALUE_LEN
      ? `${scrubbed.slice(0, MAX_FIELD_VALUE_LEN)}…`
      : scrubbed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    const joined = value.map((v) => formatPayloadValue(v)).join(', ')
    return joined.length > MAX_FIELD_VALUE_LEN
      ? `${joined.slice(0, MAX_FIELD_VALUE_LEN)}…`
      : joined
  }
  try {
    const serialized = JSON.stringify(value)
    const scrubbed = scrubSecretShapes(serialized)
    return scrubbed.length > MAX_FIELD_VALUE_LEN
      ? `${scrubbed.slice(0, MAX_FIELD_VALUE_LEN)}…`
      : scrubbed
  } catch {
    return '[unserializable]'
  }
}

/** Render the structured payload as a deterministic Markdown bullet list. */
function renderPayloadMarkdown(payload: Record<string, unknown>): string {
  const entries = Object.entries(payload)
  if (entries.length === 0) return '_(no additional context)_'
  return entries.map(([key, value]) => `- **${key}**: ${formatPayloadValue(value)}`).join('\n')
}

/**
 * Compose the alert message in three parallel renderings (subject + markdown
 * + structured). All three share the same recursively scrubbed-then-bounded
 * payload so a consumer that reads any one is guaranteed not to see
 * secret-shaped data.
 */
export function composeAlertMessage(input: AlertMessageInput): AlertMessage {
  const scrubbedPayload: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input.triggerPayload)) {
    scrubbedPayload[key] = scrubPayloadValue(value)
  }

  const subject = `[Janusly] ${input.policyName} — ${input.trigger}`

  const recoveryLine = input.recoveryCenterUrl
    ? `\n\n[Open Recovery Center](${input.recoveryCenterUrl})`
    : ''

  const markdown = [
    `**${subject}**`,
    '',
    renderPayloadMarkdown(scrubbedPayload),
    recoveryLine,
  ]
    .join('\n')
    .trim()

  return {
    subject,
    markdown,
    structured: {
      policyName: input.policyName,
      trigger: input.trigger,
      payload: scrubbedPayload,
      recoveryCenterUrl: input.recoveryCenterUrl ?? null,
      dispatchedAtIso: new Date().toISOString(),
    },
  }
}

function scrubPayloadValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') {
    const scrubbed = scrubSecretShapes(value)
    return scrubbed.length > MAX_FIELD_VALUE_LEN
      ? `${scrubbed.slice(0, MAX_FIELD_VALUE_LEN)}…`
      : scrubbed
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((entry) => scrubPayloadValue(entry, seen))
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const out: Record<string, unknown> = {}
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = scrubPayloadValue(nested, seen)
    }
    seen.delete(value)
    return out
  }
  return String(value)
}
