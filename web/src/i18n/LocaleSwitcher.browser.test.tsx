import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { LocaleSwitcher } from './LocaleSwitcher'

describe('<LocaleSwitcher variant="popover-row" /> (browser)', () => {
  it('keeps a compact select inside the row padding, opposite its label', () => {
    render(
      <div style={{ width: 320 }}>
        <LocaleSwitcher variant="popover-row" />
      </div>,
    )
    const select = screen.getByRole('combobox').getBoundingClientRect()
    const label = screen.getByText('Language').getBoundingClientRect()
    const row = screen.getByRole('combobox').parentElement!.getBoundingClientRect()

    expect(select.width).toBe(160)
    expect(row.right - select.right).toBe(14)
    expect(label.right).toBeLessThan(select.left)
  })

  it('shows the language icon only in the auth corner', () => {
    const { container, rerender } = render(<LocaleSwitcher variant="popover-row" />)
    expect(container.querySelector('svg')).toBeNull()

    rerender(<LocaleSwitcher variant="auth-corner" />)
    expect(container.querySelector('svg')).not.toBeNull()
  })
})
