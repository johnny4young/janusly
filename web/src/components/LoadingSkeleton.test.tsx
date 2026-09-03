import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { LoadingSkeleton } from './LoadingSkeleton'

describe('<LoadingSkeleton />', () => {
  it('renders the requested rows with a polite status label', () => {
    const { getByTestId, container } = render(<LoadingSkeleton rows={4} label="Loading" />)
    const root = getByTestId('loading-skeleton')
    expect(root).toHaveAttribute('role', 'status')
    expect(root).toHaveAttribute('aria-label', 'Loading')
    expect(container.querySelectorAll('.we-skeleton__row')).toHaveLength(4)
  })

  it('defaults to 3 rows', () => {
    const { container } = render(<LoadingSkeleton />)
    expect(container.querySelectorAll('.we-skeleton__row')).toHaveLength(3)
  })
})
