/**
 * Error boundary around the React Flow canvas. A malformed node/edge (bad
 * config shape, NaN coordinates, a throw in a custom renderer) would otherwise
 * crash the whole editor subtree with no recoverable UI. This catches the
 * render error and shows a localized fallback (passed by the parent, which owns
 * i18n) so the operator can reload instead of being locked out.
 *
 * Once tripped, an error boundary stays in the fallback until it unmounts — and
 * the canvas subtree stays mounted across most tab navigation, so without a
 * reset path a single transient render error would lock the operator out until
 * a full page reload. `resetKey` is the recovery hatch: when it changes (the
 * parent passes the current workflow id), the tripped state clears so switching
 * workflows re-renders the children instead. The clear happens via
 * `getDerivedStateFromProps`, not a remount, so a healthy canvas keeps its
 * React Flow viewport/instance across an unrelated workflow switch.
 *
 * Must be a class component — `componentDidCatch` / `getDerivedStateFromError`
 * have no hook equivalent. Used by `WorkflowCanvas.tsx`.
 */

import React from 'react'

type Props = {
  children: React.ReactNode
  fallback: React.ReactNode
  /** Changing this clears a tripped fallback (e.g. the active workflow id), so
   *  a render error doesn't strand the operator until a full reload. */
  resetKey?: string | number
}
type State = { hasError: boolean; renderedKey: string | number | undefined }

export class CanvasErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, renderedKey: this.props.resetKey }

  static getDerivedStateFromError(): Partial<State> {
    return { hasError: true }
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    // The reset key moved (operator switched workflows) → clear the tripped
    // state so the new workflow renders instead of the stale fallback.
    if (props.resetKey !== state.renderedKey) {
      return { hasError: false, renderedKey: props.resetKey }
    }
    return null
  }

  componentDidCatch(error: unknown): void {
    // Surface for diagnostics; the fallback keeps the rest of the app usable.
    console.error('[canvas] render error caught by boundary', error)
  }

  render(): React.ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}
