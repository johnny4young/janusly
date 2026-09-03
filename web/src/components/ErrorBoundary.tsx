/**
 * Render-error boundary for a subtree that must not take the app down with it.
 *
 * A throw during render unmounts the whole React tree by default — one panel
 * dereferencing an unexpected API envelope would blank the entire workspace,
 * not just its own card. This catches the error and shows a fallback so the
 * rest of the app stays usable.
 *
 * Two recovery hatches, because a tripped boundary otherwise stays in the
 * fallback until it unmounts:
 *  - `resetKey` — clears the tripped state when it changes (the canvas passes
 *    the workflow id, panels pass the active tab), via `getDerivedStateFromProps`
 *    rather than a remount, so a healthy subtree keeps its instance state (React
 *    Flow viewport, scroll position) across an unrelated switch.
 *  - `fallback` as a render function receiving `reset` — lets the fallback offer
 *    an in-place retry, which for a data-driven panel usually beats telling the
 *    operator to reload the whole page.
 *
 * Must be a class component — `componentDidCatch` / `getDerivedStateFromError`
 * have no hook equivalent.
 *
 * Used by: `WorkflowCanvas.tsx` (canvas), `RightPanel.tsx` (every tab panel),
 * and `App.tsx` (the Recovery Center home surface).
 */

import React from 'react'

/** Fallback rendered with an in-place retry for the tripped subtree. */
export type ErrorBoundaryFallbackRender = (context: { reset: () => void }) => React.ReactNode

type Props = {
  children: React.ReactNode
  fallback: React.ReactNode | ErrorBoundaryFallbackRender
  /** Changing this clears a tripped fallback (workflow id, active tab, …), so
   *  a render error doesn't strand the operator until a full reload. */
  resetKey?: string | number
  /** Prefix for the diagnostic console line, e.g. `canvas` or `panel:runs`. */
  logTag?: string
}
type State = { hasError: boolean; renderedKey: string | number | undefined }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, renderedKey: this.props.resetKey }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // The reset key moved (operator switched workflows / tabs) → clear the
    // tripped state so the new subtree renders instead of the stale fallback.
    if (props.resetKey !== state.renderedKey) {
      return { hasError: false, renderedKey: props.resetKey }
    }
    return null
  }

  componentDidCatch(error: unknown): void {
    // Surface for diagnostics; the fallback keeps the rest of the app usable.
    console.error(`[${this.props.logTag ?? 'ui'}] render error caught by boundary`, error)
  }

  private reset = (): void => {
    this.setState({ hasError: false })
  }

  render(): React.ReactNode {
    if (!this.state.hasError) return this.props.children
    const { fallback } = this.props
    return typeof fallback === 'function'
      ? (fallback as ErrorBoundaryFallbackRender)({ reset: this.reset })
      : fallback
  }
}
