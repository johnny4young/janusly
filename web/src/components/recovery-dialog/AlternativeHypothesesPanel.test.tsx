import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { AlternativeHypothesesPanel } from './AlternativeHypothesesPanel'

describe('<AlternativeHypothesesPanel />', () => {
  it('hides empty state and renders bounded scrubbed alternatives on demand', () => {
    const { rerender } = render(<AlternativeHypothesesPanel alternatives={[]} />)
    expect(screen.queryByTestId('recovery-hypotheses')).toBeNull()

    const secret = `sk-${'a'.repeat(20)}`
    rerender(<AlternativeHypothesesPanel alternatives={[
      { approach: `Raise timeout ${secret}`, rejectedBecause: 'Could hide\nauth failure.' },
      { approach: 'Swap provider', rejectedBecause: 'No approved provider is configured.' },
      { approach: 'Ignored third', rejectedBecause: 'Bounded to two.' },
    ]} />)
    const panel = screen.getByTestId('recovery-hypotheses')
    expect(panel).not.toHaveAttribute('open')
    fireEvent.click(screen.getByText(/Why this fix/i))
    expect(panel).toHaveAttribute('open')
    expect(panel).toHaveTextContent('Raise timeout [redacted]')
    expect(panel).toHaveTextContent('Could hide auth failure.')
    expect(panel).not.toHaveTextContent('Ignored third')
  })

  it('ignores malformed server data instead of crashing the recovery dialog', () => {
    const { rerender } = render(<AlternativeHypothesesPanel alternatives="bad" />)
    expect(screen.queryByTestId('recovery-hypotheses')).toBeNull()

    rerender(<AlternativeHypothesesPanel alternatives={[null, { approach: 'missing reason' }]} />)
    expect(screen.queryByTestId('recovery-hypotheses')).toBeNull()
  })
})
