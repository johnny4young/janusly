import { ErrorBoundary, PanelErrorFallback } from '@janusly/web'

/**
 * Catches a render error in its subtree and shows `fallback` in place of it,
 * instead of blanking the workspace. `fallback` may be a node or a function
 * receiving `{ reset }`, which is how a fallback clears the boundary itself.
 * Changing `resetKey` also clears a tripped boundary, so navigating away and
 * back recovers without a reload.
 */

/** A component that throws, so the boundary is actually exercised. */
function Boom(): never {
  throw new Error('Simulated render failure in a workspace panel')
}

/** The healthy path — children render, the boundary is invisible. */
export function Healthy() {
  return (
    <ErrorBoundary logTag="panel:runs" fallback={<PanelErrorFallback onRetry={() => {}} />}>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--we-text-2)' }}>
        Run history loaded normally — the boundary adds no markup of its own.
      </p>
    </ErrorBoundary>
  )
}

/** Tripped, showing the standard panel fallback. */
export function Tripped() {
  return (
    <ErrorBoundary logTag="panel:runs" fallback={<PanelErrorFallback onRetry={() => {}} />}>
      <Boom />
    </ErrorBoundary>
  )
}

/** A render-function fallback, which receives `reset` to clear itself. */
export function RenderFunctionFallback() {
  return (
    <ErrorBoundary
      logTag="canvas"
      fallback={({ reset }) => <PanelErrorFallback onRetry={reset} />}
    >
      <Boom />
    </ErrorBoundary>
  )
}
