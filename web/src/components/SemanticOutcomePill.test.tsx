import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { SemanticOutcomePill } from './SemanticOutcomePill'

describe('<SemanticOutcomePill />', () => {
  it('distinguishes a business outcome failure from technical run status', () => {
    render(
      <SemanticOutcomePill
        status="semantic_violation"
        testId="outcome"
      />,
    )
    expect(screen.getByTestId('outcome')).toHaveTextContent('Semantic failure')
    expect(screen.getByTestId('outcome')).toHaveAttribute(
      'data-outcome-status',
      'semantic_violation',
    )
    expect(screen.getByTestId('outcome')).toHaveAttribute(
      'data-tone',
      'warn',
    )
  })

  it('uses the blocking tone only for a quarantined outcome', () => {
    render(
      <SemanticOutcomePill
        status="semantic_quarantined"
        testId="quarantined"
      />,
    )
    expect(screen.getByTestId('quarantined')).toHaveAttribute(
      'data-tone',
      'danger',
    )
  })
})
