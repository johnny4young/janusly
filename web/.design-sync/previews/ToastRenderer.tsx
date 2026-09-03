import { ToastRenderer } from '@janusly/web'
import { Seed, Stage } from './_stage'

/**
 * The global toast stack, mounted once by `Layout` so any component can post to
 * it via the store's `addToast`. It renders nothing while the queue is empty.
 *
 * All three tones are seeded into one cell rather than split across stories:
 * the stack is a single surface, and its spacing and ordering only read
 * correctly when several toasts are on screen at once. Newest sits last.
 *
 * The stack is `position: fixed; bottom: 18px; right: 18px`, and preview cells
 * are their own containing block, so it needs a cell with real height or the
 * toasts land above the visible area entirely.
 *
 * Store-gated, so one story — see `_stage.tsx`.
 */
export function AllTones() {
  return (
    <Seed
      patch={{
        toasts: [
          { id: 't1', tone: 'success', message: 'Workflow "Invoice reconciliation" saved as version 7.' },
          { id: 't2', tone: 'info', message: 'Canary rollout is at 25% of traffic.' },
          { id: 't3', tone: 'error', message: 'Replay failed: credential "stripe_restricted_key" is not configured.' },
        ],
      }}
    >
      <Stage minHeight={360}>
        <ToastRenderer />
      </Stage>
    </Seed>
  )
}
