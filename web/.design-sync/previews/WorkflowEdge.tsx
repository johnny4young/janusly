import { CanvasWorkspace } from '@janusly/web'

/**
 * A path between two steps. Three kinds share one component, and the visual
 * difference is the whole point of it:
 *
 * - a plain edge — the run continues here;
 * - a **conditional** edge (`data.condition`) — taken only when the expression
 *   is true. The grammar is deliberately small: comparisons, boolean
 *   composition, and dotted paths that must start with `context.` or `inputs.`;
 * - an **on-error** edge (`data.onError`) — the failure route. Taking it means
 *   the run continues down this path instead of failing, and no recovery case
 *   is opened, which is why it has to be distinguishable at a glance.
 *
 * `hasCondition` and `hasOnError` are the render flags the canvas sets from
 * that data; they are what draw the label on the path.
 *
 * Each edge must also carry `type: 'workflowEdge'` — the key this component is
 * registered under. Without it React Flow draws its own default edge, which
 * looks like a plain line and shows no label at all.
 *
 * Like the step node, this is a React Flow edge type: React Flow instantiates
 * it from the graph, so the canvas is what mounts here. The edges on this card
 * are the real component.
 */

const noop = () => {}
const handlers = {
  onNodesChange: noop,
  onEdgesChange: noop,
  onConnect: noop,
  onNodeClick: noop,
  onEdgeClick: noop,
}

const step = (id: string, x: number, y: number, label: string, type: string, config: Record<string, unknown>) =>
  ({ id, type: 'workflowStep', position: { x, y }, data: { label, type, config } })

const nodes = [
  step('fetch', 0, 0, 'Fetch invoice', 'http', { method: 'GET', url: 'https://api.acme.com/v1/invoices/{{ inputs.invoiceId }}' }),
  step('compare', 320, 0, 'Compare to PO', 'agent', { model: 'claude-sonnet-5' }),
  step('notify', 640, -110, 'Notify billing', 'tool', { tool: 'slack.post' }),
  step('quarantine', 640, 130, 'Quarantine the invoice', 'tool', { tool: 'sheets.append' }),
]

/** All three path kinds on one graph: plain, conditional, and on-error. */
export function PathKinds() {
  return (
    <div style={{ height: 520 }}>
      <CanvasWorkspace
        mode="author"
        active
        nodes={nodes}
        edges={[
          { id: 'plain', type: 'workflowEdge', source: 'fetch', target: 'compare', data: {} },
          {
            id: 'conditional',
            type: 'workflowEdge',
            source: 'compare',
            target: 'notify',
            data: { condition: 'context.compare.output.match === false', hasCondition: true },
          },
          {
            id: 'on-error',
            type: 'workflowEdge',
            source: 'compare',
            target: 'quarantine',
            data: { onError: true, hasOnError: true },
          },
        ]}
        {...handlers}
      />
    </div>
  )
}
