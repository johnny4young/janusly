import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'

vi.mock('../api', () => ({ api: vi.fn() }))
vi.mock('./McpToolConfigField', () => ({
  McpToolConfigField: () => <section data-testid="mcp-tool-config" />,
}))

import { QuickConfigEditor } from './QuickConfigEditor'

beforeEach(() => {
  initI18n('en')
  vi.mocked(api).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
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

  it('explains the buffered JSON output contract and localizes tool descriptions', () => {
    const view = render(
      <QuickConfigEditor
        nodeId="fetch"
        type="http"
        config={{ url: 'https://api.example.com' }}
        tools={[]}
        onUpdate={vi.fn()}
      />,
    )
    expect(screen.getByText(/Declared JSON responses up to 64 KiB/)).toHaveTextContent('output.jsonParseSkipped')
    expect(screen.getByTestId('http-json-contract-helper')).toBeVisible()

    initI18n('es')
    view.rerender(
      <QuickConfigEditor
        nodeId="parse"
        type="tool"
        config={{ tool: 'json.parse', input: { value: '{}' } }}
        tools={[{
          name: 'json.parse',
          description: 'Parse a JSON string into its native object, array, or primitive value.',
          descriptionCode: 'json-parse',
          required: ['value'],
        }]}
        onUpdate={vi.fn()}
      />,
    )
    expect(screen.getByText('Interpreta una cadena JSON como su objeto, arreglo o valor primitivo nativo.')).toBeInTheDocument()
  })
})

describe('<QuickConfigEditor /> guided workflow choices', () => {
  it('selects another active workflow by name while excluding the current flow', () => {
    const onUpdate = vi.fn()
    const { container } = render(
      <QuickConfigEditor
        nodeId="child-flow"
        type="subworkflow"
        config={{}}
        tools={[]}
        currentWorkflowId="parent"
        workflows={[
          { id: 'parent', name: 'Parent flow' },
          { id: 'child', name: 'Child flow' },
        ]}
        onUpdate={onUpdate}
      />,
    )

    const picker = screen.getByLabelText('Workflow id') as HTMLInputElement
    const choices = container.querySelector('datalist')
    expect(choices?.querySelector('option[value="parent"]')).toBeNull()
    expect(choices?.querySelector('option[value="child"]')).toHaveAttribute('label', 'Child flow — child')
    expect(picker).toHaveAttribute('aria-describedby', expect.stringContaining('-helper'))
    fireEvent.change(picker, { target: { value: 'child' } })
    expect(onUpdate).toHaveBeenCalledWith({ workflowId: 'child' })
  })

  it('preserves, clears, and manually replaces an id outside the bounded loaded list', () => {
    const onUpdate = vi.fn()
    render(
      <QuickConfigEditor
        nodeId="child-flow"
        type="subworkflow"
        config={{ workflowId: 'legacy-child' }}
        tools={[]}
        workflows={[]}
        onUpdate={onUpdate}
      />,
    )

    const picker = screen.getByLabelText('Workflow id')
    expect(picker).toHaveValue('legacy-child')
    fireEvent.change(picker, { target: { value: '' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ workflowId: '' })
    fireEvent.change(picker, { target: { value: 'unloaded-child' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ workflowId: 'unloaded-child' })
  })

  it('marks a configured self-reference invalid while leaving it editable', () => {
    const onUpdate = vi.fn()
    const { container } = render(
      <QuickConfigEditor
        nodeId="child-flow"
        type="subworkflow"
        config={{ workflowId: 'parent' }}
        tools={[]}
        currentWorkflowId="parent"
        workflows={[
          { id: 'parent', name: 'Parent flow' },
          { id: 'child', name: 'Child flow' },
        ]}
        onUpdate={onUpdate}
      />,
    )

    const picker = screen.getByLabelText('Workflow id')
    expect(picker).toHaveValue('parent')
    expect(picker).toHaveAttribute('aria-invalid', 'true')
    expect(picker).toHaveAttribute('aria-errormessage', expect.stringContaining('-helper'))
    expect(screen.getByText('A workflow cannot call itself directly. Choose another workflow or clear this field.')).toBeInTheDocument()
    expect(container.querySelector('datalist option[value="parent"]')).toBeNull()
    fireEvent.change(picker, { target: { value: '' } })
    expect(onUpdate).toHaveBeenCalledWith({ workflowId: '' })
  })
})

describe('<QuickConfigEditor /> schedule validation', () => {
  it('marks cron grammar failures invalid without treating transport errors as validation failures', async () => {
    vi.useFakeTimers()
    vi.mocked(api)
      .mockResolvedValueOnce({ valid: false, nextFires: [] })
      .mockRejectedValueOnce(new Error('offline'))
    const onUpdate = vi.fn()
    const view = render(
      <QuickConfigEditor
        nodeId="schedule-step"
        type="schedule"
        config={{ cronExpression: 'invalid', enabled: true }}
        tools={[]}
        onUpdate={onUpdate}
      />,
    )

    const input = screen.getByLabelText('Cron expression')
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAttribute('aria-errormessage', expect.stringContaining('-preview'))

    view.rerender(
      <QuickConfigEditor
        nodeId="schedule-step"
        type="schedule"
        config={{ cronExpression: '0 9 * * *', enabled: true }}
        tools={[]}
        onUpdate={onUpdate}
      />,
    )
    expect(input).not.toHaveAttribute('aria-invalid')
    await act(async () => { await vi.advanceTimersByTimeAsync(250) })
    expect(screen.getByText("The next runs couldn't be calculated right now.")).toBeInTheDocument()
    expect(input).not.toHaveAttribute('aria-invalid')
  })
})
