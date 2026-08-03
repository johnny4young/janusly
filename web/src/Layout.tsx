/**
 * Top-level chrome — three-pane layout (left sidebar, main canvas, right
 * panel) plus a slot for the top-bar header and an optional bottom status
 * bar. The toast renderer is mounted at this level so any component can
 * dispatch toasts without threading the renderer through the tree.
 *
 * Used by `App.tsx`.
 */

import React, { useEffect, useRef, useState } from 'react'
import { Menu, X } from 'lucide-react'
import { ToastRenderer } from './components/ToastRenderer'
import { useDialogFocusTrap } from './hooks/useDialogFocusTrap'
import { MOBILE_WORKSPACE_QUERY, useMediaQuery } from './hooks/useMediaQuery'
import { useT } from './i18n'

/**
 * Render the app's three-pane shell with optional header + status bar.
 * The optional `overlay` slot mounts above the workspace (modal dialogs,
 * full-screen confirms) without forcing each caller to portal into the
 * document body.
 */
export function Layout({ sidebar, main, panel, header, overlay, statusBar, authoring = false }: {
  sidebar: React.ReactNode
  main: React.ReactNode
  /** When `null` / `undefined` / `false`, the right panel is hidden and
   *  the main area expands across its column. The Recovery Center relies
   *  on this to feel like a true hero landing page instead of a sidebar
   *  fragment. */
  panel: React.ReactNode | null
  header?: React.ReactNode
  overlay?: React.ReactNode
  /** Optional 32px footer rendered under the workspace — the operator
   *  status bar (queue / DLQ / active runs / build / shortcuts). */
  statusBar?: React.ReactNode
  /** Gives the canvas a wider center column than list/detail workspaces. */
  authoring?: boolean
}) {
  const { t } = useT()
  const hasPanel = panel !== null && panel !== undefined && panel !== false
  const hasStatusBar = statusBar !== null && statusBar !== undefined && statusBar !== false
  const shellClass = hasStatusBar ? 'app-shell app-shell--with-status' : 'app-shell'
  const isMobile = useMediaQuery(MOBILE_WORKSPACE_QUERY)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const mobileNavRef = useRef<HTMLDivElement | null>(null)
  useDialogFocusTrap(mobileNavRef, { active: isMobile && mobileNavOpen, initialFocus: true })

  useEffect(() => {
    if (!isMobile) setMobileNavOpen(false)
  }, [isMobile])

  useEffect(() => {
    if (!isMobile || !mobileNavOpen) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setMobileNavOpen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [isMobile, mobileNavOpen])

  const closeMobileNavigation = () => setMobileNavOpen(false)

  return (
    <div className={shellClass}>
      {header && (
        <header className="top-bar">
          {header}
        </header>
      )}

      <div className="mobile-nav-bar">
        <button
          type="button"
          className="mobile-nav-trigger"
          aria-controls="workspace-sidebar"
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen(true)}
        >
          <Menu size={16} aria-hidden="true" />
          <span>{t('layout.mobileNav.open')}</span>
        </button>
      </div>

      {isMobile && mobileNavOpen && (
        <div
          className="mobile-nav-backdrop"
          aria-hidden="true"
          data-testid="mobile-nav-backdrop"
          onMouseDown={closeMobileNavigation}
        />
      )}

      <div className={[
        'workspace-grid',
        !hasPanel && 'workspace-grid--no-panel',
        authoring && 'workspace-grid--authoring',
      ].filter(Boolean).join(' ')}>
        <div
          ref={mobileNavRef}
          id="workspace-sidebar"
          className={`workspace-sidebar ${mobileNavOpen ? 'workspace-sidebar--mobile-open' : ''}`}
          role={isMobile ? 'dialog' : undefined}
          aria-modal={isMobile ? true : undefined}
          aria-label={isMobile ? t('layout.mobileNav.label') : undefined}
          aria-hidden={isMobile && !mobileNavOpen ? true : undefined}
          inert={isMobile && !mobileNavOpen}
          onClick={(event) => {
            if (!isMobile || !mobileNavOpen) return
            const target = event.target as HTMLElement
            if (target.closest('[data-mobile-nav-close="true"]')) closeMobileNavigation()
          }}
        >
          <div className="mobile-nav-drawer-header">
            <strong>{t('layout.mobileNav.label')}</strong>
            <button
              type="button"
              className="mobile-nav-close"
              onClick={closeMobileNavigation}
              aria-label={t('layout.mobileNav.close')}
            >
              <X size={16} aria-hidden="true" />
            </button>
          </div>
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

      {hasStatusBar && (
        <footer className="bottom-status-bar">
          {statusBar}
        </footer>
      )}

      {overlay}
      <ToastRenderer />
    </div>
  )
}
