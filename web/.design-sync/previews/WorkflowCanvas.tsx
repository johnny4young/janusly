import { CanvasWorkspace } from '@janusly/web'
import { graphEdges, graphNodes } from './_fixtures'

/**
 * The workflow graph itself — the surface an author builds on and an operator
 * reads a run from.
 *
 * `WorkflowCanvas` needs a `ReactFlowProvider` above it, and the codebase has
 * exactly one wrapper that supplies it: `CanvasWorkspace`, whose whole body is
 * `<ReactFlowProvider><WorkflowCanvas {...props} /></ReactFlowProvider>`. So
 * that is what mounts here, and the props below are `WorkflowCanvas`'s own,
 * passed straight through. The canvas on this card is the real component.
 *
 * `mode` decides what the graph permits: `author` allows drag, connect and
 * reconnect; `observe` renders an immutable run snapshot that can still be
 * panned, zoomed and focused. `active` keeps a mounted-but-hidden canvas inert
 * so it holds its viewport without reacting to document-level events.
 *
 * React Flow measures its container on mount — inside a zero-height parent it
 * draws nothing.
 */

const handlers = {
  onNodesChange: () => {},
  onEdgesChange: () => {},
  onConnect: () => {},
  onNodeClick: () => {},
  onEdgeClick: () => {},
  onAddNode: () => {},
}

/** Author mode: the step palette entry point and undo/redo are live. */
export function AuthorMode() {
  return (
    <div style={{ height: 520 }}>
      <CanvasWorkspace nodes={graphNodes} edges={graphEdges} mode="author" active {...handlers} />
    </div>
  )
}

/** Observe mode: the same graph, marked read-only and unchangeable. */
export function ObserveMode() {
  return (
    <div style={{ height: 520 }}>
      <CanvasWorkspace nodes={graphNodes} edges={graphEdges} mode="observe" readOnly active {...handlers} />
    </div>
  )
}
