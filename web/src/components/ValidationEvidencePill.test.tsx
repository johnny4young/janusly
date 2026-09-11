import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ValidationEvidencePill } from './ValidationEvidencePill'

describe('<ValidationEvidencePill />', () => {
  it('does not style simulated provider evidence as real success', () => {
    render(<ValidationEvidencePill level="provider_simulated" testId="evidence" />)

    expect(screen.getByTestId('evidence')).toHaveTextContent('Provider simulated')
    expect(screen.getByTestId('evidence')).toHaveAttribute('data-tone', 'info')
    expect(screen.getByTestId('evidence')).toHaveAttribute('title', expect.stringContaining('not a live provider'))
  })

  it('keeps missing evidence explicitly unknown', () => {
    render(<ValidationEvidencePill level={null} testId="evidence" />)
    expect(screen.getByTestId('evidence')).toHaveTextContent('Evidence unavailable')
    expect(screen.getByTestId('evidence')).toHaveAttribute('data-tone', 'warning')
  })
})
