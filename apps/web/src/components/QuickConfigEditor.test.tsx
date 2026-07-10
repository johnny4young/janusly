import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { initI18n } from '../i18n'

vi.mock('./McpToolConfigField', () => ({
  McpToolConfigField: () => <section data-testid="mcp-tool-config" />,
}))

import { QuickConfigEditor } from './QuickConfigEditor'

beforeEach(() => {
  initI18n('en')
})

describe('<QuickConfigEditor /> resilience wiring', () => {
  it.each(['http', 'tool', 'agent', 'mcp_tool'] as const)('mounts resilience controls for %s nodes', (type) => {
    render(
      <QuickConfigEditor
        nodeId="external-step"
        type={type}
        config={type === 'http' ? { url: 'https://api.example.com' } : {}}
        tools={[]}
        onUpdate={vi.fn()}
      />,
    )

    expect(screen.getByTestId('resilience-fieldset')).toBeInTheDocument()
  })

  it('merges a resilience edit into the current node config', () => {
    const onUpdate = vi.fn()
    render(
      <QuickConfigEditor
        nodeId="external-step"
        type="http"
        config={{ url: 'https://api.example.com' }}
        tools={[]}
        onUpdate={onUpdate}
      />,
    )

    const retryAttempts = screen.getByLabelText('Retry attempts')
    fireEvent.change(retryAttempts, { target: { value: '3' } })
    fireEvent.blur(retryAttempts)

    expect(onUpdate).toHaveBeenLastCalledWith({
      url: 'https://api.example.com',
      retry: { maxAttempts: 3 },
    })
  })
})
