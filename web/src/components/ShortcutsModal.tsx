/**
 * Keyboard shortcuts overlay — opened by pressing `?` outside a form
 * input. Renders a compact two-column list of every global keybinding
 * Janusly ships today.
 *
 * Used by `App.tsx` in the overlay slot. ESC closes the modal; clicking
 * the backdrop also closes.
 */

import { useRef } from 'react'
import { Keyboard, X } from 'lucide-react'
import { useDialogFocusTrap } from '../hooks/useDialogFocusTrap'
import { useT } from '../i18n'
import {
  canOpenWorkspaceDestination,
  type WorkspaceDestination,
} from '../workspace-locations'

type Group = {
  title: string
  items: Array<{
    keys: string[]
    description: string
    permission?: string
    destination?: WorkspaceDestination
  }>
}

export function ShortcutsModal({ open, onClose, permissions }: {
  open: boolean
  onClose: () => void
  permissions?: readonly string[]
}) {
  const { t } = useT()

  const dialogRef = useRef<HTMLDivElement | null>(null)
  // Always-mounted (renders null while closed); focus its close button on open
  // so the Tab trap has something inside to cycle.
  useDialogFocusTrap(dialogRef, { active: open, initialFocus: true, onEscape: onClose })

  if (!open) return null

  const groups = ([
    {
      title: t('shortcuts.group.global'),
      items: [
        { keys: ['⌘', 'K'], description: t('shortcuts.cmdk') },
        { keys: ['⌘', 'S'], description: t('shortcuts.save'), permission: 'workflows.write' },
        { keys: ['⌘', '1'], description: t('shortcuts.home'), destination: 'home' },
        { keys: ['⌘', '2'], description: t('shortcuts.workflows'), destination: 'workflows' },
        { keys: ['⌘', '3'], description: t('shortcuts.activity'), destination: 'activity' },
        { keys: ['⌘', '4'], description: t('shortcuts.settings'), destination: 'settings' },
        { keys: ['?'], description: t('shortcuts.helpThis') },
        { keys: ['⌃', '⇧', 'Q'], description: t('shortcuts.signOut') },
      ],
    },
    {
      title: t('shortcuts.group.palette'),
      items: [
        { keys: ['↑', '↓'], description: t('shortcuts.paletteNav') },
        { keys: ['↵'], description: t('shortcuts.paletteRun') },
        { keys: ['ESC'], description: t('shortcuts.paletteClose') },
      ],
    },
    {
      title: t('shortcuts.group.sidebar'),
      items: [
        { keys: ['/'], description: t('shortcuts.sidebarSearch') },
      ],
    },
    {
      title: t('shortcuts.group.recovery'),
      items: [
        { keys: ['J', 'K'], description: t('shortcuts.recoveryMove'), permission: 'recovery.read' },
        { keys: ['R'], description: t('shortcuts.recoveryReplay'), permission: 'dlq.replay' },
        { keys: ['⌘/Ctrl', '↵'], description: t('shortcuts.recoveryResolve'), permission: 'recovery.write' },
      ],
    },
  ] satisfies Group[]).map((group) => ({
    ...group,
    items: permissions === undefined
      ? group.items
      : group.items.filter((item) =>
        (!item.permission || permissions.includes(item.permission))
        && (!item.destination || canOpenWorkspaceDestination(item.destination, permissions))),
  })).filter((group) => group.items.length > 0)

  return (
    <div
      ref={dialogRef}
      className="we-shortcuts-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t('shortcuts.title')}
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
          <button type="button" className="we-shortcuts-close" onClick={onClose} aria-label={t('shortcuts.close')}>
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
