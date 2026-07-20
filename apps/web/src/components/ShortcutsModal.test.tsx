import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ShortcutsModal } from './ShortcutsModal'

describe('<ShortcutsModal />', () => {
  it('lists recovery triage navigation and actions', () => {
    render(<ShortcutsModal open onClose={vi.fn()} />)

    expect(screen.getByText('Recovery queue')).toBeInTheDocument()
    expect(screen.getByText('Move between recovery rows')).toBeInTheDocument()
    expect(screen.getByText('Replay the focused failure')).toBeInTheDocument()
    expect(screen.getByText('Resolve the focused failure')).toBeInTheDocument()
  })
})
