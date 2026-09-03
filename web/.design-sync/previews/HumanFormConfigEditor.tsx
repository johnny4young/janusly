import { HumanFormConfigEditor } from '@janusly/web'

/**
 * Quick-config editor for a human-form step: the title and instructions the
 * operator sees when a run pauses for structured input. The schema itself is
 * edited separately, through `SchemaFieldsEditor` in form mode.
 */

/** A configured form step. */
export function Configured() {
  return (
    <HumanFormConfigEditor
      nodeId="confirm_refund"
      config={{
        title: 'Confirm the refund',
        description:
          'The invoice total differs from the purchase order by more than the auto-approve threshold. Check line 7 against the PO before deciding.',
      }}
      onUpdate={() => {}}
    />
  )
}

/** Title only — instructions left to the schema field descriptions. */
export function TitleOnly() {
  return (
    <HumanFormConfigEditor
      nodeId="collect_reference"
      config={{ title: 'Supply the ledger reference' }}
      onUpdate={() => {}}
    />
  )
}

/** A fresh step. */
export function Empty() {
  return <HumanFormConfigEditor nodeId="human_form_1" config={{}} onUpdate={() => {}} />
}
