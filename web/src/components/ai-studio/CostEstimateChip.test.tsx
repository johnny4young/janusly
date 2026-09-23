import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CostEstimateChip } from './CostEstimateChip'

describe('<CostEstimateChip />', () => {
  it('updates a known-model estimate and hides it when pricing is unavailable', () => {
    const { rerender } = render(<CostEstimateChip action="proposal" model="claude-sonnet-5" />)
    expect(screen.getByTestId('ai-cost-proposal')).toHaveTextContent(/\$/)

    rerender(<CostEstimateChip action="review" model="claude-sonnet-5" />)
    expect(screen.getByTestId('ai-cost-review')).toHaveTextContent(/\$/)
    expect(screen.queryByTestId('ai-cost-proposal')).not.toBeInTheDocument()

    rerender(<CostEstimateChip action="review" model="unknown-model" />)
    expect(screen.queryByTestId('ai-cost-review')).not.toBeInTheDocument()
  })
})
