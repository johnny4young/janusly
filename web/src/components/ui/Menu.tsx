import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Button, type ButtonProps } from './Button'
import './Menu.css'

const GAP_PX = 4

export type MenuEntry = {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  /** A single key that selects this entry while the menu is open. */
  shortcut?: string
  danger?: boolean
  testId?: string
  onSelect: () => void
}

type MenuProps = Omit<ButtonProps, 'onClick' | 'onKeyDown'> & {
  items: readonly MenuEntry[]
  menuId?: string
  menuTestId?: string
}

/** A button-anchored action menu. Fixed positioning keeps it visible inside
 * tables that scroll horizontally, so moving the page dismisses it. */
export function Menu({ items, menuId, menuTestId, ...trigger }: MenuProps) {
  const [open, setOpen] = useState(false)
  const triggerId = useId()
  const generatedMenuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const menu = menuRef.current
    const anchor = triggerRef.current
    if (!open || !menu || !anchor) return
    const a = anchor.getBoundingClientRect()
    const m = menu.getBoundingClientRect()
    const below = a.bottom + GAP_PX
    const fitsBelow = below + m.height <= window.innerHeight
    menu.style.top = `${fitsBelow ? below : Math.max(GAP_PX, a.top - m.height - GAP_PX)}px`
    menu.style.left = `${Math.max(GAP_PX, Math.min(a.right, window.innerWidth - GAP_PX) - m.width)}px`
    menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [open])

  useEffect(() => {
    if (!open) return
    const dismiss = () => setOpen(false)
    const dismissOutside = (event: MouseEvent) => {
      const target = event.target as Node
      if (!menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) dismiss()
    }
    document.addEventListener('mousedown', dismissOutside)
    window.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('mousedown', dismissOutside)
      window.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
    }
  }, [open])

  const closeToTrigger = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }

  // Focus goes back first so a dialog opened by the action restores to the trigger.
  const select = (item: MenuEntry) => {
    closeToTrigger()
    item.onSelect()
  }

  const onMenuKeyDown = (event: KeyboardEvent) => {
    const entries = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    const current = entries.indexOf(document.activeElement as HTMLElement)
    const focusAt = (index: number) => entries[(index + entries.length) % entries.length]?.focus()
    if (event.key === 'Escape' || event.key === 'Tab') closeToTrigger()
    else if (event.key === 'ArrowDown') focusAt(current + 1)
    else if (event.key === 'ArrowUp') focusAt(current - 1)
    else if (event.key === 'Home') focusAt(0)
    else if (event.key === 'End') focusAt(-1)
    else {
      const match = event.metaKey || event.ctrlKey || event.altKey
        ? undefined
        : items.find((item) => item.shortcut === event.key)
      if (!match) return
      select(match)
    }
    event.preventDefault()
    event.stopPropagation()
  }

  const menuDomId = menuId ?? generatedMenuId
  return (
    <>
      <Button
        {...trigger}
        id={triggerId}
        ref={triggerRef}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuDomId}
        onClick={(event) => { event.stopPropagation(); setOpen((current) => !current) }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return
          event.preventDefault()
          setOpen(true)
        }}
      />
      {open && (
        <div
          ref={menuRef}
          id={menuDomId}
          role="menu"
          aria-labelledby={triggerId}
          className="ui-menu"
          data-testid={menuTestId}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={onMenuKeyDown}
        >
          {items.map((item) => (
            <Button
              key={item.id}
              role="menuitem"
              tabIndex={-1}
              variant="ghost"
              className="ui-menu__item"
              data-danger={item.danger ? 'true' : undefined}
              leadingIcon={item.icon}
              trailingIcon={item.shortcut ? <kbd>{item.shortcut}</kbd> : undefined}
              aria-keyshortcuts={item.shortcut}
              data-testid={item.testId}
              onClick={() => select(item)}
            >
              <strong>{item.label}</strong>
              {item.description && <small>{item.description}</small>}
            </Button>
          ))}
        </div>
      )}
    </>
  )
}
