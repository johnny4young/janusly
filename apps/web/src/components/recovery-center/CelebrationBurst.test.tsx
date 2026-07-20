import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { CelebrationBurst } from './CelebrationBurst'

let reducedMotion = false
vi.mock('../../hooks/usePrefersReducedMotion', () => ({
  usePrefersReducedMotion: () => reducedMotion,
}))

describe('<CelebrationBurst />', () => {
  beforeEach(() => {
    reducedMotion = false
  })

  it('renders ten inert particles and remounts them for a new trigger', () => {
    const { rerender } = render(<CelebrationBurst trigger={1} />)
    const first = screen.getByTestId('celebration-burst')
    expect(first.children).toHaveLength(10)
    expect(first).toHaveAttribute('aria-hidden', 'true')

    rerender(<CelebrationBurst trigger={2} />)
    expect(screen.getByTestId('celebration-burst')).not.toBe(first)
    expect(screen.getByTestId('celebration-burst')).toHaveAttribute('data-trigger', '2')
  })

  it('renders nothing before a trigger or under reduced motion', () => {
    const { rerender } = render(<CelebrationBurst trigger={0} />)
    expect(screen.queryByTestId('celebration-burst')).toBeNull()

    reducedMotion = true
    rerender(<CelebrationBurst trigger={1} />)
    expect(screen.queryByTestId('celebration-burst')).toBeNull()
  })
})
