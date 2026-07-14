import { fireEvent, render, waitFor } from '@testing-library/react'
import { StrictMode, useRef } from 'react'
import { describe, expect, it } from 'vitest'
import { useDialogFocusTrap } from './useDialogFocusTrap'

function Dialog() {
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocusTrap(ref)
  return (
    <div ref={ref} role="dialog">
      <button data-testid="first">first</button>
      <button data-testid="last">last</button>
    </div>
  )
}

function ToggleDialog({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useDialogFocusTrap(ref, { active, initialFocus: true })
  return active ? (
    <div ref={ref} role="dialog">
      <button data-testid="initial">initial</button>
      <button disabled data-testid="disabled">disabled</button>
    </div>
  ) : null
}

function PreferredFocusDialog({ active, preferredDisabled = false }: { active: boolean; preferredDisabled?: boolean }) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const preferredRef = useRef<HTMLButtonElement>(null)
  useDialogFocusTrap(dialogRef, { active, initialFocus: preferredRef })
  return active ? (
    <div ref={dialogRef} role="dialog">
      <button data-testid="fallback">fallback</button>
      <button ref={preferredRef} data-testid="preferred" disabled={preferredDisabled}>preferred</button>
    </div>
  ) : null
}

describe('useDialogFocusTrap', () => {
  it('wraps Tab from the last focusable back to the first', () => {
    const { getByTestId } = render(<Dialog />)
    const first = getByTestId('first')
    const last = getByTestId('last')
    last.focus()
    expect(document.activeElement).toBe(last)
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('wraps Shift+Tab from the first focusable back to the last', () => {
    const { getByTestId } = render(<Dialog />)
    const first = getByTestId('first')
    const last = getByTestId('last')
    first.focus()
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('ignores Tab while focus is outside the dialog', () => {
    const { getByTestId } = render(
      <>
        <button data-testid="outside">outside</button>
        <Dialog />
      </>,
    )
    const outside = getByTestId('outside')
    outside.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // No trap: focus stays on the outside control.
    expect(document.activeElement).toBe(outside)
  })

  it('keeps initial focus on the first enabled control through the Strict Mode effect replay', async () => {
    const { getByTestId } = render(
      <StrictMode>
        <ToggleDialog active />
      </StrictMode>,
    )

    await waitFor(() => expect(document.activeElement).toBe(getByTestId('initial')))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(document.activeElement).toBe(getByTestId('initial'))
  })

  it('focuses a preferred control and keeps it focused through the Strict Mode effect replay', async () => {
    const { getByTestId } = render(
      <StrictMode>
        <PreferredFocusDialog active />
      </StrictMode>,
    )

    await waitFor(() => expect(document.activeElement).toBe(getByTestId('preferred')))
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    expect(document.activeElement).toBe(getByTestId('preferred'))
  })

  it('falls back to the first focusable control when the preferred target is disabled', async () => {
    const { getByTestId } = render(<PreferredFocusDialog active preferredDisabled />)

    await waitFor(() => expect(document.activeElement).toBe(getByTestId('fallback')))
  })

  it('restores focus to the trigger when an active dialog closes', async () => {
    const { getByTestId, rerender } = render(
      <>
        <button data-testid="trigger">trigger</button>
        <ToggleDialog active={false} />
      </>,
    )
    getByTestId('trigger').focus()

    rerender(
      <>
        <button data-testid="trigger">trigger</button>
        <ToggleDialog active />
      </>,
    )
    await waitFor(() => expect(document.activeElement).toBe(getByTestId('initial')))

    rerender(
      <>
        <button data-testid="trigger">trigger</button>
        <ToggleDialog active={false} />
      </>,
    )
    await waitFor(() => expect(document.activeElement).toBe(getByTestId('trigger')))
  })
})
