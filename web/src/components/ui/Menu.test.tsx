import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Menu } from './Menu'

function setup() {
  const first = vi.fn()
  const second = vi.fn()
  const onParentClick = vi.fn()
  render(
    <div onClick={onParentClick}>
      <Menu
        data-testid="trigger"
        items={[
          { id: 'a', label: 'First', shortcut: '1', testId: 'first', onSelect: first },
          { id: 'b', label: 'Second', shortcut: '2', testId: 'second', onSelect: second },
        ]}
      >
        Actions
      </Menu>
      <button type="button">outside</button>
    </div>,
  )
  return { first, second, onParentClick, trigger: screen.getByTestId('trigger') }
}

describe('<Menu />', () => {
  it('focuses the first item on open and never lets a click reach the parent', () => {
    const { trigger, onParentClick, first } = setup()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(trigger)
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByTestId('first')).toHaveFocus()
    fireEvent.click(screen.getByTestId('first'))
    expect(first).toHaveBeenCalledOnce()
    expect(onParentClick).not.toHaveBeenCalled()
  })

  it('opens with ArrowDown and moves with the arrow, Home and End keys, wrapping', () => {
    const { trigger } = setup()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const menu = screen.getByRole('menu')
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByTestId('second')).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowDown' })
    expect(screen.getByTestId('first')).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'ArrowUp' })
    expect(screen.getByTestId('second')).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'Home' })
    expect(screen.getByTestId('first')).toHaveFocus()
    fireEvent.keyDown(menu, { key: 'End' })
    expect(screen.getByTestId('second')).toHaveFocus()
  })

  it.each(['Escape', 'Tab'])('%s closes the menu and returns focus to the trigger', (key) => {
    const { trigger, first, second } = setup()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })

  it('selects by shortcut unless a modifier is held', () => {
    const { trigger, second } = setup()
    fireEvent.click(trigger)
    fireEvent.keyDown(screen.getByRole('menu'), { key: '2', metaKey: true })
    expect(second).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByRole('menu'), { key: '2' })
    expect(second).toHaveBeenCalledOnce()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('returns focus before the action runs, so a dialog it opens restores to the trigger', () => {
    let focusedDuringAction: Element | null = null
    render(<Menu data-testid="t" items={[{ id: 'a', label: 'A', testId: 'a', onSelect: () => { focusedDuringAction = document.activeElement } }]}>Go</Menu>)
    fireEvent.click(screen.getByTestId('t'))
    fireEvent.click(screen.getByTestId('a'))
    expect(focusedDuringAction).toBe(screen.getByTestId('t'))
  })

  it('dismisses on an outside press and on scroll, without taking focus', () => {
    const { trigger } = setup()
    fireEvent.click(trigger)
    fireEvent.mouseDown(screen.getByRole('button', { name: 'outside' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    fireEvent.click(trigger)
    fireEvent.scroll(window)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens upward when it would not fit below, and stays inside the left edge', () => {
    const rects: Record<string, Partial<DOMRect>> = {
      BUTTON: { top: 700, bottom: 730, right: 100 },
      DIV: { width: 180, height: 90 },
    }
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return rects[this.tagName] as DOMRect
    })
    vi.stubGlobal('innerHeight', 768)
    const { trigger } = setup()
    fireEvent.click(trigger)
    const menu = screen.getByRole('menu')
    expect(menu.style.top).toBe('606px')
    expect(menu.style.left).toBe('4px')
    spy.mockRestore()
    vi.unstubAllGlobals()
  })

  it('stays closed when disabled', () => {
    render(<Menu data-testid="off" disabled items={[]}>Off</Menu>)
    fireEvent.click(screen.getByTestId('off'))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
