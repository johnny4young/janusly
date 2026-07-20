/**
 * Tests for the global keyboard-shortcut listener — focused on Cmd/Ctrl+S
 * saving even while typing and suppressing the browser's save-page dialog,
 * plus a non-regression check that the typing guard still applies to `?`.
 */

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { isKeyboardShortcutTypingTarget } from '../keyboard-shortcut-target'
import { useKeyboardShortcuts, type KeyboardShortcutHandlers } from './useKeyboardShortcuts'

function mountShortcuts(overrides: Partial<KeyboardShortcutHandlers> = {}) {
  const handlers: KeyboardShortcutHandlers = {
    onTogglePalette: vi.fn(),
    onToggleShortcuts: vi.fn(),
    onFocusSidebarSearch: vi.fn(() => false),
    onSave: vi.fn(),
    onOpenHome: vi.fn(),
    onOpenStudio: vi.fn(),
    onSignOut: vi.fn(),
    ...overrides,
  }
  renderHook(() => useKeyboardShortcuts(handlers))
  return handlers
}

function pressKey(key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

describe('useKeyboardShortcuts — Cmd/Ctrl+S', () => {
  it('fires onSave and suppresses the browser save dialog', () => {
    const handlers = mountShortcuts()
    const event = pressKey('s', { metaKey: true })
    expect(handlers.onSave).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('fires while typing in a form field (an author mid-config-edit expects save to work)', () => {
    const handlers = mountShortcuts()
    const input = document.createElement('input')
    document.body.appendChild(input)
    pressKey('s', { ctrlKey: true }, input)
    expect(handlers.onSave).toHaveBeenCalledTimes(1)
    input.remove()
  })

  it('does NOT fire on a bare "s" or on Cmd+Shift+S', () => {
    const handlers = mountShortcuts()
    pressKey('s')
    pressKey('s', { metaKey: true, shiftKey: true })
    expect(handlers.onSave).not.toHaveBeenCalled()
  })

  it('leaves the existing shortcuts working (Cmd+K palette, ? guarded while typing)', () => {
    const handlers = mountShortcuts()
    pressKey('k', { metaKey: true })
    expect(handlers.onTogglePalette).toHaveBeenCalledTimes(1)

    const input = document.createElement('input')
    document.body.appendChild(input)
    pressKey('?', {}, input)
    expect(handlers.onToggleShortcuts).not.toHaveBeenCalled()
    input.remove()
  })

  it('navigates with the advertised Cmd/Ctrl+1 and Cmd/Ctrl+2 shortcuts', () => {
    const handlers = mountShortcuts()
    const home = pressKey('1', { metaKey: true })
    const studio = pressKey('2', { ctrlKey: true })

    expect(handlers.onOpenHome).toHaveBeenCalledTimes(1)
    expect(handlers.onOpenStudio).toHaveBeenCalledTimes(1)
    expect(home.defaultPrevented).toBe(true)
    expect(studio.defaultPrevented).toBe(true)

    pressKey('1', { metaKey: true, shiftKey: true })
    pressKey('2')
    expect(handlers.onOpenHome).toHaveBeenCalledTimes(1)
    expect(handlers.onOpenStudio).toHaveBeenCalledTimes(1)
  })
})

describe('isKeyboardShortcutTypingTarget', () => {
  it('recognizes inputs, textareas, selects, and editable content', () => {
    const input = document.createElement('input')
    const textarea = document.createElement('textarea')
    const select = document.createElement('select')
    const editable = document.createElement('div')
    editable.contentEditable = 'true'

    expect(isKeyboardShortcutTypingTarget(input)).toBe(true)
    expect(isKeyboardShortcutTypingTarget(textarea)).toBe(true)
    expect(isKeyboardShortcutTypingTarget(select)).toBe(true)
    expect(isKeyboardShortcutTypingTarget(editable)).toBe(true)
    expect(isKeyboardShortcutTypingTarget(document.createElement('button'))).toBe(false)
  })
})
