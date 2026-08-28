import { SafeMarkdown } from '@janusly/web'

/**
 * Markdown renderer over a deliberately small syntax subset: headings, lists,
 * `<pre>`, `<hr>`, and the inline marks `**bold**`, `*italic*`, `` `code` ``
 * and links. Blockquotes and tables are **not** supported and pass through as
 * literal text.
 *
 * `allowOperatorLinks` defaults to `true` for operator-authored content like
 * runbooks; set it to `false` for anything an AI surface produced, so
 * generated links are not rendered as clickable.
 */

/** Operator-authored runbook content — the default posture. */
export function Runbook() {
  return (
    <SafeMarkdown
      source={[
        '## Invoice reconciliation',
        '',
        'Runs nightly at 02:00 UTC. If the workflow fails, check these in order:',
        '',
        '1. **Upstream reachable** — the billing API must answer `/health`.',
        '2. **Credential valid** — the `acme-billing` token rotates every 90 days.',
        '3. **Schema drift** — compare the response against the recorded shape.',
        '',
        'Escalate to the billing on-call if all three pass and it still fails.',
      ].join('\n')}
    />
  )
}

/** AI-generated explanation, with operator links suppressed. */
export function AiGenerated() {
  return (
    <SafeMarkdown
      allowOperatorLinks={false}
      source={[
        'The run failed at step **fetch_invoice** with a `503` from the upstream API.',
        '',
        'This signature has appeared 14 times in the last 7 days, always between',
        '02:00 and 02:15 UTC — consistent with the provider’s maintenance window.',
        '',
        'Suggested change: raise the timeout from `30s` to `90s`.',
      ].join('\n')}
    />
  )
}

/** Inline formatting, lists, and code the renderer has to handle. */
export function RichFormatting() {
  return (
    <SafeMarkdown
      source={[
        'Supported inline marks: **bold**, *italic*, `inline code`.',
        '',
        '- Unordered items',
        '- With `code` inside them',
        '- And a third, so the list shape reads',
      ].join('\n')}
    />
  )
}
