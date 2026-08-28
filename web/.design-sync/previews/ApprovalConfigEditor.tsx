import { ApprovalConfigEditor } from '@janusly/web'

/**
 * Quick-config editor for a human-approval step: the message the approver
 * sees, who it is assigned to, and what happens if nobody decides in time.
 *
 * The deadline mode is derived from the config rather than stored — setting
 * `decisionTimeoutMs` selects "after a duration", `until` selects "at a
 * timestamp", and neither means no deadline. `onTimeout` is one of `fail`,
 * `auto_reject`, or `escalate`; only `escalate` reveals the `escalateTo`
 * field.
 */

/** Fails the run when the deadline passes — the safe default. */
export function FailOnTimeout() {
  return (
    <ApprovalConfigEditor
      nodeId="approve_refund"
      config={{
        message: 'Approve a refund of {{ steps.total.output }} for invoice {{ inputs.invoiceId }}?',
        assignee: 'billing-oncall@acme.com',
        onTimeout: 'fail',
        decisionTimeoutMs: 3600000,
      }}
      onUpdate={() => {}}
    />
  )
}

/** Escalates to a second approver instead of failing — reveals `escalateTo`. */
export function EscalateOnTimeout() {
  return (
    <ApprovalConfigEditor
      nodeId="approve_refund"
      config={{
        message: 'Refund above the auto-approve threshold — needs a human decision.',
        assignee: 'dana@acme.com',
        onTimeout: 'escalate',
        escalateTo: 'finance-lead@acme.com',
        decisionTimeoutMs: 14400000,
      }}
      onUpdate={() => {}}
    />
  )
}

/** Rejects automatically rather than failing the run. */
export function AutoRejectOnTimeout() {
  return (
    <ApprovalConfigEditor
      nodeId="approve_refund"
      config={{
        message: 'Approve this adjustment before it reaches the ledger.',
        assignee: 'billing-oncall@acme.com',
        onTimeout: 'auto_reject',
        decisionTimeoutMs: 1800000,
      }}
      onUpdate={() => {}}
    />
  )
}

/** No deadline at all — the timeout controls stay hidden. */
export function NoDeadline() {
  return (
    <ApprovalConfigEditor
      nodeId="approve_refund"
      config={{ message: 'Confirm before the ledger write.', assignee: 'dana@acme.com' }}
      onUpdate={() => {}}
    />
  )
}

/** A fresh step with nothing filled in yet. */
export function Empty() {
  return <ApprovalConfigEditor nodeId="approval_1" config={{}} onUpdate={() => {}} />
}
