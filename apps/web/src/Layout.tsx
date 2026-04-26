import React from 'react'
import { ToastRenderer } from './components/ToastRenderer'

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
