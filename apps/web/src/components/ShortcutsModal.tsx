/**
 * Keyboard shortcuts overlay — opened by pressing `?` outside a form
 * input. Renders a compact two-column list of every global keybinding
 * Janusly ships today.
 *
 * Used by `App.tsx` in the overlay slot. ESC closes the modal; clicking
 * the backdrop also closes.
 */

import { useEffect, useRef } from 'react'
import { Keyboard, X } from 'lucide-react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { useT } from '../i18n'

type Group = {
  title: string
  items: Array<{ keys: string[]; description: string }>
}

export function ShortcutsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useT()

  useEffect(() => {
    if (!open) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, onClose])

  const dialogRef = useRef<HTMLDivElement | null>(null)
  // Always-mounted (renders null while closed); focus its close button on open
  // so the Tab trap has something inside to cycle.
  useDialogFocusTrap(dialogRef, { active: open, initialFocus: true })

  if (!open) return null

  const groups: Group[] = [
    {
      title: t('shortcuts.group.global') as string,
      items: [
        { keys: ['⌘', 'K'], description: t('shortcuts.cmdk') as string },
        { keys: ['⌘', 'S'], description: t('shortcuts.save') as string },
        { keys: ['⌘', '1'], description: t('shortcuts.home') as string },
        { keys: ['⌘', '2'], description: t('shortcuts.studio') as string },
        { keys: ['?'], description: t('shortcuts.helpThis') as string },
        { keys: ['⌃', '⇧', 'Q'], description: t('shortcuts.signOut') as string },
      ],
    },
    {
      title: t('shortcuts.group.palette') as string,
      items: [
        { keys: ['↑', '↓'], description: t('shortcuts.paletteNav') as string },
        { keys: ['↵'], description: t('shortcuts.paletteRun') as string },
        { keys: ['ESC'], description: t('shortcuts.paletteClose') as string },
      ],
    },
    {
      title: t('shortcuts.group.sidebar') as string,
      items: [
        { keys: ['/'], description: t('shortcuts.sidebarSearch') as string },
      ],
    },
    {
      title: t('shortcuts.group.recovery') as string,
      items: [
        { keys: ['J', 'K'], description: t('shortcuts.recoveryMove') as string },
        { keys: ['R'], description: t('shortcuts.recoveryReplay') as string },
        { keys: ['⌘/Ctrl', '↵'], description: t('shortcuts.recoveryResolve') as string },
      ],
    },
  ]

  return (
    <div
      ref={dialogRef}
      className="we-shortcuts-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('shortcuts.title') as string}
      data-testid="shortcuts-modal"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="we-shortcuts-dialog">
        <header className="we-shortcuts-head">
          <span className="we-shortcuts-head-ic" aria-hidden="true"><Keyboard size={16} /></span>
          <div className="we-shortcuts-head-body">
            <div className="section-kicker">{t('shortcuts.kicker')}</div>
            <h2>{t('shortcuts.title')}</h2>
          </div>
          <button type="button" className="we-shortcuts-close" onClick={onClose} aria-label={t('shortcuts.close') as string}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="we-shortcuts-body">
          {groups.map((group) => (
            <section key={group.title} className="we-shortcuts-group">
              <h3>{group.title}</h3>
              <ul>
                {group.items.map((item) => (
                  <li key={item.description}>
                    <span className="we-shortcuts-kbds">
                      {item.keys.map((key) => <kbd key={key}>{key}</kbd>)}
                    </span>
                    <span className="we-shortcuts-desc">{item.description}</span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
