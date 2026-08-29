import { CanvasWorkspace } from '@janusly/web'
import { graphEdges, graphNodes } from './_fixtures'

/**
 * The workflow editor canvas, wrapped in the React Flow provider it owns.
 *
 * The provider lives here rather than at the app root so `@xyflow/react` — the
 * heaviest dependency in the bundle — stays off the boot path and ships in this
 * component's own on-demand chunk. An operator who lands on Home downloads none
 * of it.
 *
 * `mode` is the important prop. `author` is the editor: drag, connect,
 * reconnect. `observe` renders an immutable run snapshot — pan, zoom and focus
 * still work, but the graph cannot be changed, which is how a finished run is
 * read without disturbing the workflow it came from.
 *
 * React Flow measures its container on mount, so the canvas needs a parent with
 * real height; inside a zero-height box it mounts and draws nothing. (The
 * pieces it renders — `WorkflowCanvas`, `WorkflowStepNode`, `WorkflowEdge` —
 * cannot be previewed on their own: they need a provider ancestor from this
 * same module instance, and only this component supplies one.)
 */

const handlers = {
  onNodesChange: () => {},
  onEdgesChange: () => {},
  onConnect: () => {},
  onNodeClick: () => {},
  onEdgeClick: () => {},
  onAddNode: () => {},
}

/** The editor: a three-step flow with one conditional path. */
export function Authoring() {
  return (
    <div style={{ height: 520 }}>
      <CanvasWorkspace nodes={graphNodes} edges={graphEdges} mode="author" active {...handlers} />
    </div>
  )
}

/** The same graph as an immutable run snapshot. */
export function Observing() {
  return (
    <div style={{ height: 520 }}>
      <CanvasWorkspace nodes={graphNodes} edges={graphEdges} mode="observe" readOnly active {...handlers} />
    </div>
  )
}
