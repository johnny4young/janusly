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
})
