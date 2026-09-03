import { CommandPalette } from '@janusly/web'
import { Stage } from './_stage'

/**
 * Keyboard-first navigation and actions. It mixes fixed commands (validate,
 * save, start a run, sign out) with dynamic results — the workspace's saved
 * workflows and recipes — so one search box reaches both.
 *
 * `permissions` is the filter that matters, and the strings are
 * **dot-separated** (`workflows.write`, `runs.write`); the colon form matches
 * nothing and silently hides every gated command. `docsUrl` is a validated
 * build-time capability: without it the Docs command does not exist.
 */

const workflows = [
  { id: 'wf_invoice_recon', name: 'Invoice reconciliation' },
  { id: 'wf_dunning', name: 'Dunning follow-up' },
  { id: 'wf_refund_audit', name: 'Refund audit' },
]

const recipes = [
  { id: 'rcp_http_retry', name: 'HTTP call with retry and backoff' },
  { id: 'rcp_human_gate', name: 'Human approval before a write' },
]

const handlers = {
  openTab: () => {},
  onValidate: () => {},
  onSave: () => {},
  onStart: () => {},
  onNew: () => {},
  onSignOut: () => {},
  onInsertSnippet: () => {},
  onOpenWorkflow: () => {},
  onOpenRecipe: () => {},
  onClose: () => {},
}

/** An editor: every command available, docs wired up. */
export function FullAccess() {
  return (
    <Stage minHeight={680}>
      <CommandPalette
        open
        {...handlers}
        docsUrl="https://docs.janusly.com"
        workflows={workflows}
        recipes={recipes}
        permissions={['workflows.read', 'workflows.write', 'runs.read', 'runs.write', 'recovery.read']}
      />
    </Stage>
  )
}

/** A viewer: the write commands are filtered out, not disabled. */
export function ReadOnlyAccess() {
  return (
    <Stage minHeight={680}>
      <CommandPalette
        open
        {...handlers}
        workflows={workflows}
        recipes={recipes}
        permissions={['workflows.read', 'runs.read']}
      />
    </Stage>
  )
}
