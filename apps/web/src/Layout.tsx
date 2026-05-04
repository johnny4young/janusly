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

/**
 * Render the app's three-pane shell with optional header. The optional
 * `overlay` slot mounts above the workspace (modal dialogs, full-screen
 * confirms) without forcing each caller to portal into the document body.
 */
export function Layout({ sidebar, main, panel, header, overlay }: {
  sidebar: React.ReactNode
  main: React.ReactNode
  panel: React.ReactNode
  header?: React.ReactNode
  overlay?: React.ReactNode
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

      {overlay}
      <ToastRenderer />
    </div>
  )
}
