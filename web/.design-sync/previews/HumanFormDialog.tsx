import type { ReactNode } from 'react'
import { HumanFormDialog } from '@janusly/web'

/**
 * The form a run pauses on when a step needs a human to supply structured
 * input. Like `RunInputDialog`, the fields come from a JSON-schema shape —
 * this one is what the human-form step declares.
 */

/**
 * Overlay stage. The preview card wraps each cell in a
 * `transform: translateZ(0)` element, which makes that cell the containing
 * block for `position: fixed` descendants. Janusly modal backdrops are
 * `position: fixed; inset: 0`, so they resolve against the CELL, not the
 * viewport — and a content-sized cell collapses to a few dozen pixels, leaving
 * the centred panel hanging off the top. An explicit height fixes both.
 */
function Stage({ children }: { children: ReactNode }) {
  return <div style={{ minHeight: 760, position: 'relative' }}>{children}</div>
}

const approvalSchema = {
  type: 'object' as const,
  properties: {
    decision: { type: 'string' as const, description: 'Your call', enum: ['approve', 'reject'] },
    adjustedTotal: { type: 'number' as const, description: 'Corrected total, if the invoice was wrong' },
    note: { type: 'string' as const, description: 'Why — recorded on the run timeline' },
  },
  required: ['decision', 'note'],
}

/** The canonical composition, with its own title and description. */
export function Default() {
  return (
    <Stage>
      <HumanFormDialog
        title="Confirm the refund"
        description="The invoice total differs from the purchase order by more than the auto-approve threshold."
        schema={approvalSchema}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </Stage>
  )
}

/** Reopened with the operator's earlier answers still in place. */
export function Prefilled() {
  return (
    <Stage>
      <HumanFormDialog
        title="Confirm the refund"
        schema={approvalSchema}
        initialValues={{ decision: 'approve', adjustedTotal: 1284.5, note: 'Line 7 was double-counted upstream.' }}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </Stage>
  )
}

/** Rejected server-side — errors echoed back onto the fields. */
export function WithServerErrors() {
  return (
    <Stage>
      <HumanFormDialog
        title="Confirm the refund"
        schema={approvalSchema}
        initialValues={{ decision: 'approve' }}
        serverErrors={['$.note is required', '$.adjustedTotal must be a positive number']}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </Stage>
  )
}

/** Submission in flight. */
export function Submitting() {
  return (
    <Stage>
      <HumanFormDialog
        title="Confirm the refund"
        schema={approvalSchema}
        initialValues={{ decision: 'approve', note: 'Verified against the PO.' }}
        submitting
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </Stage>
  )
}
