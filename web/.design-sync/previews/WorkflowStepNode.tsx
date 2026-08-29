import { CanvasWorkspace } from '@janusly/web'

/**
 * One step on the canvas. The node shows its label, a plain-language line for
 * what the step kind does, the single most useful config value (a URL, a tool
 * name, an agent goal), and a status pill once a run has touched it.
 *
 * It is a React Flow node type, so React Flow instantiates it — it cannot be
 * rendered directly from props, and it needs a provider ancestor from this same
 * module instance. Mounting the canvas is therefore the only way to see it, and
 * the nodes on this card are the real component: React Flow builds each one
 * from the `data` below.
 *
 * `data.status` is what carries a run's outcome back onto the authoring
 * surface, and `data.hasValidationError` marks a step that will not pass
 * validation — the two are independent, because a step can be configured
 * correctly and still fail at run time.
 */

const noop = () => {}
const handlers = {
  onNodesChange: noop,
  onEdgesChange: noop,
  onConnect: noop,
  onNodeClick: noop,
  onEdgeClick: noop,
}

const node = (
  id: string,
  x: number,
  y: number,
  data: { label: string; type: string; config: Record<string, unknown>; status?: string; hasValidationError?: boolean },
) => ({ id, type: 'workflowStep', position: { x, y }, data })

/** The step kinds, each carrying a different run status. */
export function StepKinds() {
  return (
    <div style={{ height: 520 }}>
      <CanvasWorkspace
        mode="observe"
        readOnly
        active
        edges={[]}
        nodes={[
          node('fetch', 0, 0, {
            label: 'Fetch invoice',
            type: 'http',
            config: { url: 'https://api.acme.com/v1/invoices/{{ inputs.invoiceId }}', method: 'GET' },
            status: 'failed',
          }),
          node('compare', 0, 150, {
            label: 'Compare to PO',
            type: 'agent',
            config: { model: 'claude-sonnet-5', goal: 'Flag any line item that does not match the purchase order.' },
            status: 'succeeded',
          }),
          node('approve', 0, 300, {
            label: 'Approve the write-off',
            type: 'human_form',
            config: { onTimeout: 'escalate', timeout: 'PT15M' },
            status: 'waiting',
          }),
          node('notify', 0, 450, {
            label: 'Notify billing',
            type: 'tool',
            config: { tool: 'slack.post', channel: '#billing' },
            status: 'skipped',
          }),
        ]}
        {...handlers}
      />
    </div>
  )
}

/** A step that will not pass validation, flagged before the run starts. */
export function ValidationError() {
  return (
    <div style={{ height: 340 }}>
      <CanvasWorkspace
        mode="author"
        active
        edges={[]}
        nodes={[
          node('charge', 0, 0, {
            label: 'Charge the card',
            type: 'http',
            config: { url: '', method: 'POST' },
            hasValidationError: true,
          }),
        ]}
        {...handlers}
      />
    </div>
  )
}
