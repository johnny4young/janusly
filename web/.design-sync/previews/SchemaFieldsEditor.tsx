import { SchemaFieldsEditor } from '@janusly/web'

/**
 * Builds a workflow input schema field by field, so an operator declares
 * `inputs` without writing JSON Schema by hand. `form` switches it to the
 * human-form flavour, where the same schema drives an approval form instead
 * of a run payload.
 */

const invoiceSchema = {
  type: 'object' as const,
  properties: {
    invoiceId: { type: 'string' as const, description: 'Billing system invoice identifier' },
    currency: { type: 'string' as const, enum: ['USD', 'EUR', 'COP'] },
    maxLineItems: { type: 'number' as const, default: 50 },
  },
  required: ['invoiceId'],
}

/** An existing schema being edited. */
export function WithSchema() {
  return <SchemaFieldsEditor scope="workflow-inputs" schema={invoiceSchema} onChange={() => {}} />
}

/** Nothing declared yet — the starting state. */
export function EmptySchema() {
  return <SchemaFieldsEditor scope="workflow-inputs" onChange={() => {}} />
}

/** The human-form flavour of the same editor. */
export function FormMode() {
  return (
    <SchemaFieldsEditor scope="human-form" schema={invoiceSchema} form onChange={() => {}} />
  )
}
