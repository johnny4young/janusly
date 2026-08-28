import { HttpConfigEditor } from '@janusly/web'

/**
 * Quick-config editor for an HTTP step. The parent owns the `config` object
 * and receives patches through `onUpdate`; the editor renders the fields the
 * step type declares (`url`, `method`, `headers`, `body`, `bodyMode`, and the
 * streaming preview cap).
 */

/** A plain GET — the simplest useful shape. */
export function SimpleGet() {
  return (
    <HttpConfigEditor
      nodeId="fetch_invoice"
      config={{
        url: 'https://api.acme.com/v1/invoices/{{ inputs.invoiceId }}',
        method: 'GET',
        headers: { accept: 'application/json' },
      }}
      onUpdate={() => {}}
    />
  )
}

/** A POST carrying a JSON body. */
export function PostWithBody() {
  return (
    <HttpConfigEditor
      nodeId="submit_reconciliation"
      config={{
        url: 'https://api.acme.com/v1/reconciliations',
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer {{ secrets.acme }}' },
        bodyMode: 'json',
        body: { invoiceId: '{{ inputs.invoiceId }}', discrepancies: '{{ steps.compare.output }}' },
      }}
      onUpdate={() => {}}
    />
  )
}

/** An empty step, as it looks right after being dropped on the canvas. */
export function Empty() {
  return <HttpConfigEditor nodeId="http_1" config={{}} onUpdate={() => {}} />
}
