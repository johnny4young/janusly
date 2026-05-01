/**
 * Top-level chrome — three-pane layout (left sidebar, main canvas, right
 * panel) plus a slot for the top-bar header. The toast renderer is
 * mounted at this level so any component can dispatch toasts without
 * threading the renderer through the tree.
 *
 * Used by `App.tsx`.
 */

import React from 'react'
import { ToastRenderer } from './components/ToastRenderer'

/** Render the app's three-pane shell with optional header. */
export function Layout({ sidebar, main, panel, header }: {
  sidebar: React.ReactNode
  main: React.ReactNode
  panel: React.ReactNode
  header?: React.ReactNode
}) {
  return (
    <div className="app-shell">
      {header && (
        <header className="top-bar">
          {header}
        </header>
      )}

      <div className="workspace-grid">
        <div className="workspace-sidebar">
          {sidebar}
        </div>

        <main className="workspace-main">
          {main}
        </main>

        <aside className="workspace-panel">
          {panel}
        </aside>
      </div>

      <ToastRenderer />
    </div>
  )
}
