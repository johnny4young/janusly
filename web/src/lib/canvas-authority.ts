import { useWorkflowStore } from '../store'
import { sessionCan } from '../identity-context'

/** Stable ownership token for async operations that may replace the canvas. */
export function currentCanvasAuthority(state = useWorkflowStore.getState()): string {
  return JSON.stringify([state.orgId, state.userId, state.currentWorkflowId, state.workflowRevision,
    sessionCan(state.identityContext, 'workflows.write'), sessionCan(state.identityContext, 'workflows.read')])
}

export function canvasAuthorityMatches(expected: string): boolean {
  return currentCanvasAuthority() === expected
}

/** Authoring results also belong to one visible workspace and AI grant. */
export function currentAuthoringAuthority(state = useWorkflowStore.getState()): string {
  return JSON.stringify([currentCanvasAuthority(state), state.activeTab,
    sessionCan(state.identityContext, 'ai.write')])
}

/** An ownership lease ends at the first context change, even if React batches a return to the old context. */
export function ownCanvas(
  onInvalidated: () => void,
  authorityForState = currentCanvasAuthority,
): AbortController {
  const controller = new AbortController()
  const authority = authorityForState()
  const unsubscribe = useWorkflowStore.subscribe(state => {
    if (authorityForState(state) === authority) return
    controller.abort()
    onInvalidated()
  })
  controller.signal.addEventListener('abort', unsubscribe, { once: true })
  return controller
}
