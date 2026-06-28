/**
 * Error boundary around the React Flow canvas. A malformed node/edge (bad
 * config shape, NaN coordinates, a throw in a custom renderer) would otherwise
 * crash the whole editor subtree with no recoverable UI. This catches the
 * render error and shows a localized fallback (passed by the parent, which owns
 * i18n) so the operator can reload instead of being locked out.
 *
 * Must be a class component — `componentDidCatch` / `getDerivedStateFromError`
 * have no hook equivalent. Used by `WorkflowCanvas.tsx`.
 */

import React from 'react'

type Props = { children: React.ReactNode; fallback: React.ReactNode }
type State = { hasError: boolean }

export class CanvasErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: unknown): void {
    // Surface for diagnostics; the fallback keeps the rest of the app usable.
    console.error('[canvas] render error caught by boundary', error)
  }

  render(): React.ReactNode {
    return this.state.hasError ? this.props.fallback : this.props.children
  }
}
