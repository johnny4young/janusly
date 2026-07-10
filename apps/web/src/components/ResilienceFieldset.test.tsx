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
  it('writes the engine-consumed retry, HTTP, and bounds settings', () => {
    const onPatch = renderFieldset()

    const retryAttempts = screen.getByLabelText('Retry attempts')
    fireEvent.change(retryAttempts, { target: { value: '3' } })
    fireEvent.blur(retryAttempts)
    expect(onPatch).toHaveBeenLastCalledWith({ retry: { maxAttempts: 3 } })

    fireEvent.change(screen.getByLabelText('HTTP method'), { target: { value: 'POST' } })
    expect(onPatch).toHaveBeenLastCalledWith({ method: 'POST' })

    const timeout = screen.getByLabelText('Timeout (ms)')
    fireEvent.change(timeout, { target: { value: '5000' } })
    fireEvent.blur(timeout)
    expect(onPatch).toHaveBeenLastCalledWith({ timeoutMs: 5000 })

    const headers = screen.getByLabelText('Headers (JSON)')
    fireEvent.change(headers, { target: { value: '{\n  "x-request-id": "trace-1"\n}' } })
    fireEvent.blur(headers)
    expect(onPatch).toHaveBeenLastCalledWith({ headers: { 'x-request-id': 'trace-1' } })
  })

  it('caps an MCP timeout at the executor contract maximum on blur', () => {
    const onPatch = renderFieldset({ nodeType: 'mcp_tool', config: { connectionAlias: 'ops', toolName: 'tickets.list' } })

    const field = screen.getByLabelText('Timeout (ms)')
    fireEvent.change(field, { target: { value: '300000' } })
    fireEvent.blur(field, { target: { value: '300000' } })

    expect(onPatch).toHaveBeenLastCalledWith({ timeoutMs: 120000 })
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

  it('keeps HTTP-only request controls out of non-HTTP nodes', () => {
    renderFieldset({ nodeType: 'tool', config: { tool: 'http.request' } })

    expect(screen.queryByLabelText('HTTP method')).toBeNull()
    expect(screen.queryByLabelText('Headers (JSON)')).toBeNull()
  })

  it('localises the invalid HTTP headers error', () => {
    initI18n('es')
    renderFieldset()

    const headers = screen.getByLabelText('Cabeceras (JSON)')
    fireEvent.change(headers, { target: { value: '{' } })
    fireEvent.blur(headers)

    expect(screen.getByText('El valor debe ser JSON válido')).toBeInTheDocument()
  })

  it('focuses the requested fieldset after the Inspector mounts', async () => {
    requestResilienceFocus('fetch-customer')
    renderFieldset()

    await waitFor(() => {
      expect(screen.getByTestId('resilience-fieldset')).toHaveFocus()
    })
  })
})
