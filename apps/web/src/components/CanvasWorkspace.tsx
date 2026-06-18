/**
 * Lazy boundary that owns the React Flow provider for the workflow editor.
 *
 * `<ReactFlowProvider>` lives here (not at the app root) so `@xyflow/react`
 * — the heaviest dependency in the web bundle — is deferred off the boot
 * path: it ships in this component's own on-demand `CanvasWorkspace` chunk,
 * loaded only when the operator first leaves the home tab for a tab that
 * mounts the canvas. Home-landing users download zero React Flow.
 *
 * `App.tsx` renders this via `lazy()` + `<Suspense>` inside the
 * `workspace-canvas-wrapper`, which `getCanvasVisibility` keeps mounted for
 * every non-home tab (visible on canvas tabs, `display: none` on the rest).
 * Because the wrapper never unmounts across non-home navigation, the
 * `<ReactFlow>` instance — and thus the viewport (zoom + pan) — survives
 * cycles such as `inspector → operations → inspector`. A round-trip through
 * home unmounts the canvas, so it re-fits on the next mount.
 */

import { ReactFlowProvider, addEdge, applyEdgeChanges, applyNodeChanges } from '@xyflow/react'
import type { ComponentProps } from 'react'
import { WorkflowCanvas } from './WorkflowCanvas'
import { registerFlowOps } from '../store'

// Hand the store React Flow's change-appliers as soon as this (lazy) chunk
// evaluates — before any canvas interaction can fire a reducer. Keeping the
// static import here (not in the boot-reachable store) is what holds
// @xyflow/react off the boot path.
registerFlowOps({ applyNodeChanges, applyEdgeChanges, addEdge })

/** Wrap the editor canvas in its React Flow provider; props pass straight
 *  through to `WorkflowCanvas`. */
export function CanvasWorkspace(props: ComponentProps<typeof WorkflowCanvas>) {
  return (
    <ReactFlowProvider>
      <WorkflowCanvas {...props} />
    </ReactFlowProvider>
  )
}
