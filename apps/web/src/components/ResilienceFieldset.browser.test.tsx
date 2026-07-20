import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { initI18n } from '../i18n'
import { ResilienceFieldset } from './ResilienceFieldset'

describe('<ResilienceFieldset /> (browser smoke)', () => {
  afterEach(() => {
    initI18n('en')
    vi.restoreAllMocks()
  })

  it('renders HTTP resilience controls and emits a retry policy in Chromium', () => {
    initI18n('en')
    const onPatch = vi.fn()

    render(
      <ResilienceFieldset
        nodeId="fetch-customer"
        nodeType="http"
        config={{ url: 'https://api.example.com' }}
        onPatch={onPatch}
      />,
    )

    expect(screen.getByTestId('resilience-fieldset')).toBeVisible()
    const retryAttempts = screen.getByLabelText('Retry attempts')
    fireEvent.change(retryAttempts, { target: { value: '3' } })
    fireEvent.blur(retryAttempts)
    expect(onPatch).toHaveBeenLastCalledWith({ retry: { maxAttempts: 3 } })
  })

  it('renders the selective-retry classes in Spanish and toggles retryOn in Chromium', () => {
    initI18n('es')
    const onPatch = vi.fn()

    render(
      <ResilienceFieldset
        nodeId="fetch-customer"
        nodeType="http"
        config={{ url: 'https://api.example.com' }}
        onPatch={onPatch}
      />,
    )

    const block = screen.getByTestId('resilience-retry-on')
    expect(block).toBeVisible()
    expect(block.textContent).toContain('Reintentar solo en')
    expect(block.textContent).toContain('Errores de servidor (5xx)')

    fireEvent.click(screen.getByTestId('resilience-retry-on-5xx'))
    expect(onPatch).toHaveBeenLastCalledWith({ retry: { retryOn: ['5xx'] } })
  })
})
