/**
 * Latest-request guard for active-run transitions. Opening a historical run,
 * starting a new run, or changing auth context invalidates every older async
 * response so stale detail cannot replace the operator's current selection.
 *
 * Used by `App.tsx`; kept as a tiny state machine so deferred-response races
 * are unit-testable without mounting the entire application shell.
 */

export type RunTransitionGuard = {
  begin: () => RunTransitionToken
  isCurrent: (token: RunTransitionToken) => boolean
}

export type RunTransitionToken = {
  requestId: number
  generation: number
}

export type RunRequestContext = {
  runId: string
  generation: number
}

export type RunRequestState = {
  runId: string | null
  runTransitionGeneration: number
}

export function isRunRequestCurrent(context: RunRequestContext, state: RunRequestState): boolean {
  return state.runId === context.runId && state.runTransitionGeneration === context.generation
}

export function createRunTransitionGuard(readGeneration: () => number = () => 0): RunTransitionGuard {
  let currentRequestId = 0
  return {
    begin: () => {
      currentRequestId += 1
      return { requestId: currentRequestId, generation: readGeneration() }
    },
    isCurrent: token => token.requestId === currentRequestId && token.generation === readGeneration(),
  }
}
