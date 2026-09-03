import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { initI18n } from '../i18n'
import { ResilienceFieldset } from './ResilienceFieldset'
import { requestResilienceFocus } from './resilience-focus-bus'

function renderFieldset(overrides: Partial<Parameters<typeof ResilienceFieldset>[0]> = {}) {
  const onPatch = vi.fn()
  render(
    <ResilienceFieldset
      nodeId="fetch-customer"
      nodeType="http"
      config={{ url: 'https://api.example.com' }}
      onPatch={onPatch}
      {...overrides}
    />,
  )
  return onPatch
}

beforeEach(() => {
  initI18n('en')
})

afterEach(() => {
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

describe('<ResilienceFieldset />', () => {
  it('starts collapsed and writes the engine-consumed retry and bounds settings', () => {
    const onPatch = renderFieldset()
    const disclosure = screen.getByTestId('resilience-disclosure')
    expect(disclosure).not.toHaveAttribute('open')
    expect(screen.getByText('Using runtime defaults')).toBeInTheDocument()
    fireEvent.click(disclosure.querySelector('summary')!)

    const retryAttempts = screen.getByLabelText('Retry attempts')
    fireEvent.change(retryAttempts, { target: { value: '3' } })
    fireEvent.blur(retryAttempts)
    expect(onPatch).toHaveBeenLastCalledWith({ retry: { maxAttempts: 3 } })

    const timeout = screen.getByLabelText('Timeout (ms)')
    fireEvent.change(timeout, { target: { value: '5000' } })
    fireEvent.blur(timeout)
    expect(onPatch).toHaveBeenLastCalledWith({ timeoutMs: 5000 })

    const responseBytes = screen.getByLabelText('Maximum response bytes')
    fireEvent.change(responseBytes, { target: { value: '5000000' } })
    fireEvent.blur(responseBytes)
    expect(onPatch).toHaveBeenLastCalledWith({ maxResponseBytes: 5000000 })
  })

  it('caps an MCP timeout at the executor contract maximum on blur', () => {
    const onPatch = renderFieldset({ nodeType: 'mcp_tool', config: { connectionAlias: 'ops', toolName: 'tickets.list' } })

    const field = screen.getByLabelText('Timeout (ms)')
    fireEvent.change(field, { target: { value: '300000' } })
    fireEvent.blur(field, { target: { value: '300000' } })

    expect(onPatch).toHaveBeenLastCalledWith({ timeoutMs: 120000 })
  })

  it('caps HTTP resource controls at the shared process limits on blur', () => {
    const onPatch = renderFieldset()

    for (const [label, value, expected] of [
      ['Timeout (ms)', '900000', { timeoutMs: 600000 }],
      ['Maximum response bytes', '999999999', { maxResponseBytes: 67108864 }],
      ['Maximum redirects', '99', { maxRedirects: 20 }],
    ] as const) {
      const field = screen.getByLabelText(label)
      fireEvent.change(field, { target: { value } })
      fireEvent.blur(field, { target: { value } })
      expect(onPatch).toHaveBeenLastCalledWith(expected)
    }
  })

  it('keeps retry attempts at the production-readiness minimum on blur', () => {
    const onPatch = renderFieldset()

    const field = screen.getByLabelText('Retry attempts')
    fireEvent.change(field, { target: { value: '1' } })
    fireEvent.blur(field, { target: { value: '1' } })

    expect(onPatch).toHaveBeenLastCalledWith({ retry: { maxAttempts: 2 } })
  })

  it('does not mangle multi-digit entry by clamping mid-typing', () => {
    const onPatch = renderFieldset()

    // Typing "10" with min=2: the first keystroke ("1") must pass through
    // locally — a per-keystroke clamp would rewrite it to "2" and the second
    // keystroke would produce 20 instead of 10. The workflow state stays
    // valid until the operator commits the field on blur.
    const field = screen.getByLabelText('Retry attempts')
    fireEvent.change(field, { target: { value: '1' } })
    expect(field).toHaveValue(1)
    expect(onPatch).not.toHaveBeenCalled()

    fireEvent.change(field, { target: { value: '10' } })
    fireEvent.blur(field, { target: { value: '10' } })
    expect(onPatch).toHaveBeenLastCalledWith({ retry: { maxAttempts: 10 } })
  })

  it('keeps HTTP-only response bounds out of non-HTTP nodes', () => {
    renderFieldset({ nodeType: 'tool', config: { tool: 'http.request' } })

    expect(screen.queryByLabelText('Maximum response bytes')).toBeNull()
    expect(screen.queryByLabelText('Maximum redirects')).toBeNull()
  })

  it('summarises configured policy without expanding the dense controls', () => {
    renderFieldset({
      config: {
        url: 'https://api.example.com',
        retry: { maxAttempts: 3 },
        timeoutMs: 5000,
        maxResponseBytes: 1000000,
      },
    })

    expect(screen.getByText('3 custom settings')).toBeInTheDocument()
    expect(screen.getByTestId('resilience-disclosure')).not.toHaveAttribute('open')
  })

  it('opens and focuses the requested fieldset after the Inspector mounts', async () => {
    requestResilienceFocus('fetch-customer')
    renderFieldset()

    await waitFor(() => {
      expect(screen.getByTestId('resilience-disclosure')).toHaveAttribute('open')
      expect(screen.getByTestId('resilience-fieldset')).toHaveFocus()
    })
  })
})

describe('selective retry (retryOn)', () => {
  it('renders all four transient classes, none checked by default', () => {
    renderFieldset()
    for (const key of ['5xx', '429', 'timeout', 'network']) {
      const box = screen.getByTestId(`resilience-retry-on-${key}`) as HTMLInputElement
      expect(box.checked).toBe(false)
    }
    expect(screen.getByTestId('resilience-retry-on')).toHaveTextContent(/every failure is retried/i)
  })

  it('checking a class patches retry.retryOn with the engine pattern string', () => {
    const onPatch = renderFieldset()
    fireEvent.click(screen.getByTestId('resilience-retry-on-5xx'))
    expect(onPatch).toHaveBeenCalledWith({ retry: { maxAttempts: 3, retryOn: ['5xx'] } })
  })

  it('reflects an existing retryOn as checked boxes', () => {
    renderFieldset({ config: { url: 'x', retry: { maxAttempts: 3, retryOn: ['5xx', 'timeout'] } } })
    expect((screen.getByTestId('resilience-retry-on-5xx') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('resilience-retry-on-timeout') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('resilience-retry-on-429') as HTMLInputElement).checked).toBe(false)
    expect(screen.getByTestId('resilience-retry-on')).toHaveTextContent(/only the selected classes/i)
  })

  it('unchecking the last class omits retryOn rather than persisting an empty array', () => {
    const onPatch = renderFieldset({ config: { url: 'x', retry: { maxAttempts: 3, retryOn: ['5xx'] } } })
    fireEvent.click(screen.getByTestId('resilience-retry-on-5xx'))
    expect(onPatch).toHaveBeenCalledWith({ retry: { maxAttempts: 3, retryOn: undefined } })
  })
})
