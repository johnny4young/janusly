import { PanelErrorFallback } from '@janusly/web'

/**
 * What a workspace panel shows when its subtree throws. Paired with
 * `ErrorBoundary`'s `fallback` prop — `onRetry` clears the boundary so the
 * panel re-renders in place rather than forcing a full reload.
 */

/** The only state this component has. */
export function Default() {
  return <PanelErrorFallback onRetry={() => {}} />
}

/** How it sits inside a panel-width container. */
export function InPanel() {
  return (
    <div style={{ maxWidth: 420 }}>
      <PanelErrorFallback onRetry={() => {}} />
    </div>
  )
}
