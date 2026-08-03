import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { ValidationEvidencePill } from './ValidationEvidencePill'

describe('<ValidationEvidencePill />', () => {
  it('renders strong provider evidence with the success tone', () => {
    render(<ValidationEvidencePill level="provider_simulated" testId="evidence" />)

    expect(screen.getByTestId('evidence')).toHaveTextContent('Provider simulated')
    expect(screen.getByTestId('evidence')).toHaveAttribute('data-tone', 'success')
  })
})
