import { EmptyState } from '@janusly/web'
import { Inbox, Search, ShieldCheck } from 'lucide-react'

/**
 * The canonical empty slot for list surfaces (templates, tools, credentials,
 * runs, dead letters). `kicker` is the short headline, `body` the one-line
 * explanation, and the optional `cta` offers the next step.
 */

/** The primary composition: icon, headline, explanation, and a way forward. */
export function WithAction() {
  return (
    <EmptyState
      icon={<Inbox size={20} />}
      kicker="No runs yet"
      body="Once a workflow starts, every run and its outcome shows up here."
      cta={{ label: 'Start a run', onClick: () => {} }}
    />
  )
}

/** No next step to offer — the state is simply informational. */
export function WithoutAction() {
  return (
    <EmptyState
      icon={<ShieldCheck size={20} />}
      kicker="Nothing quarantined"
      body="No run has tripped a semantic guardrail in the last 30 days."
    />
  )
}

/** The filtered-to-nothing variant, where the CTA clears the filter. */
export function NoSearchResults() {
  return (
    <EmptyState
      icon={<Search size={20} />}
      kicker="No matches"
      body="No workflow matches “invoice reconciliation”. Try a broader term."
      cta={{ label: 'Clear filters', onClick: () => {} }}
    />
  )
}
