import { act, fireEvent, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'

import { changeAppLanguage } from '../../i18n'
import { RecoveryErrorBlock } from './RecoveryErrorBlock'

const DNS_ERROR = {
  name: 'Error',
  message: 'Get "https://demo-ingest.invalid/feed": dial tcp: lookup demo-ingest.invalid: no such host',
}

it('leads with the readable cause and keeps the raw JSON collapsed until asked', () => {
  render(<RecoveryErrorBlock errorJson={DNS_ERROR} nodeType="http" />)

  expect(screen.getByTestId('recovery-error-summary')).toHaveTextContent('Host demo-ingest.invalid does not resolve')
  expect(screen.getByTestId('recovery-error-cause')).toHaveTextContent('Network · DNS')
  expect(screen.getByTestId('recovery-error-retryable')).toHaveTextContent('Not retryable as-is')
  expect(screen.queryByTestId('recovery-error-raw')).not.toBeInTheDocument()

  const toggle = screen.getByTestId('recovery-error-raw-toggle')
  expect(toggle).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByTestId('recovery-error-raw')).toHaveTextContent('no such host')
})

it('renders a status cause and a retryable fact for a server error', () => {
  render(<RecoveryErrorBlock errorJson={{ message: 'boom', statusCode: 503 }} nodeType="http" />)

  expect(screen.getByTestId('recovery-error-summary')).toHaveTextContent('boom')
  expect(screen.getByTestId('recovery-error-cause')).toHaveTextContent('HTTP · 503')
  expect(screen.getByTestId('recovery-error-retryable')).toHaveTextContent('Retryable')
})

it('shows only the message when the failure is unclassified', () => {
  render(<RecoveryErrorBlock errorJson={{ message: 'something odd' }} />)

  expect(screen.getByTestId('recovery-error-summary')).toHaveTextContent('something odd')
  expect(screen.queryByTestId('recovery-error-cause')).not.toBeInTheDocument()
  expect(screen.queryByTestId('recovery-error-retryable')).not.toBeInTheDocument()
})

it('falls back to localized copy when the error carries no message', () => {
  render(<RecoveryErrorBlock errorJson={null} />)
  expect(screen.getByTestId('recovery-error-summary')).toHaveTextContent('Unknown error')
})

it('localizes the summary and facts', async () => {
  await act(async () => { await changeAppLanguage('es') })
  try {
    render(<RecoveryErrorBlock errorJson={DNS_ERROR} nodeType="http" />)
    expect(screen.getByTestId('recovery-error-summary')).toHaveTextContent('El host demo-ingest.invalid no se resuelve')
    expect(screen.getByTestId('recovery-error-cause')).toHaveTextContent('Red · DNS')
    expect(screen.getByTestId('recovery-error-retryable')).toHaveTextContent('No se puede reintentar tal cual')
  } finally {
    await act(async () => { await changeAppLanguage('en') })
  }
})
