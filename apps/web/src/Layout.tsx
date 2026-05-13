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
  /** When `null` / `undefined` / `false`, the right panel is hidden and
   *  the main area expands across its column. The Recovery Center relies
   *  on this to feel like a true hero landing page instead of a sidebar
   *  fragment. */
  panel: React.ReactNode | null
  header?: React.ReactNode
  overlay?: React.ReactNode
}) {
  const hasPanel = panel !== null && panel !== undefined && panel !== false
  return (
    <div className="app-shell">
      {header && (
        <header className="top-bar">
          {header}
        </header>
      )}

      <div className={hasPanel ? "workspace-grid" : "workspace-grid workspace-grid--no-panel"}>
        <div className="workspace-sidebar">
          {sidebar}
        </div>

        <main className="workspace-main">
          {main}
        </main>

        {hasPanel && (
          <aside className="workspace-panel">
            {panel}
          </aside>
        )}
      </div>

      {overlay}
      <ToastRenderer />
    </div>
  )
}
