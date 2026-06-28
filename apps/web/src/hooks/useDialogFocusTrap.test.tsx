import { fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
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
})
