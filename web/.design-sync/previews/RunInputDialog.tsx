import type { ReactNode } from 'react'
import { RunInputDialog } from '@janusly/web'

/**
 * The schema-driven form shown before starting a workflow that declares
 * `inputs`. The dialog builds its fields from the JSON-schema shape, so the
 * schema — not the markup — is what a caller composes.
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

const invoiceSchema = {
  type: 'object' as const,
  properties: {
    invoiceId: { type: 'string' as const, description: 'Billing system invoice identifier' },
    currency: { type: 'string' as const, description: 'ISO 4217 code', enum: ['USD', 'EUR', 'COP'] },
    maxLineItems: { type: 'number' as const, description: 'Stop after this many lines', default: 50 },
    includeAttachments: { type: 'boolean' as const, description: 'Fetch PDF attachments too' },
  },
  required: ['invoiceId'],
}

/** The canonical composition: a mixed-type schema with a required field. */
export function Default() {
  return (
    <Stage>
      <RunInputDialog
        inputs={invoiceSchema}
        workflowName="Invoice reconciliation"
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </Stage>
  )
}

/** Prefilled from a previous run, with custom submit copy. */
export function Prefilled() {
  return (
    <Stage>
      <RunInputDialog
        inputs={invoiceSchema}
        workflowName="Invoice reconciliation"
        initialValue={{ invoiceId: 'inv_10482', currency: 'USD', maxLineItems: 25, includeAttachments: true }}
        submitLabel="Replay run"
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </Stage>
  )
}

/** Validation errors echoed back from `POST /start`. */
export function WithServerErrors() {
  return (
    <Stage>
      <RunInputDialog
        inputs={invoiceSchema}
        workflowName="Invoice reconciliation"
        initialValue={{ invoiceId: '', currency: 'USD' }}
        serverErrors={['$.invoiceId is required', '$.currency must be one of USD, EUR, COP']}
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </Stage>
  )
}

/** In flight — submit disabled while the run-start request lands. */
export function Submitting() {
  return (
    <Stage>
      <RunInputDialog
        inputs={invoiceSchema}
        workflowName="Invoice reconciliation"
        initialValue={{ invoiceId: 'inv_10482', currency: 'USD' }}
        submitting
        submittingLabel="Starting…"
        onSubmit={() => {}}
        onCancel={() => {}}
      />
    </Stage>
  )
}
