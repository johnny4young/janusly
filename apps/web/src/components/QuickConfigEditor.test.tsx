import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'

vi.mock('../api', () => ({
  api: vi.fn(),
  publicApiUrl: (path: string) => `http://localhost:7311${path}`,
}))
vi.mock('./McpToolConfigField', () => ({
  McpToolConfigField: () => <section data-testid="mcp-tool-config" />,
}))

import { QuickConfigEditor } from './QuickConfigEditor'

const emptyWorkflowGraph = { workflowNodes: [], workflowEdges: [] }

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
        {...emptyWorkflowGraph}
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
        {...emptyWorkflowGraph}
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
        {...emptyWorkflowGraph}
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
        {...emptyWorkflowGraph}
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

describe('<QuickConfigEditor /> bounded per-item processing', () => {
  const tools = [{
    name: 'text.uppercase',
    description: 'Convert text to uppercase.',
    descriptionCode: 'text-uppercase',
    required: ['value'],
    inputExample: { value: 'hello' },
  }]

  it('keeps the legacy mapping editor as the default loop mode', () => {
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="batch"
        type="loop"
        config={{ items: 'a,b', mapping: { value: '{{item}}' } }}
        tools={tools}
        onUpdate={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Processing mode')).toHaveValue('map')
    expect(screen.getByLabelText('Item mapping')).toBeInTheDocument()
    expect(screen.queryByTestId('loop-for-each-config')).not.toBeInTheDocument()
  })

  it('switches to for-each with safe defaults while preserving the map config', () => {
    const onUpdate = vi.fn()
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="batch"
        type="loop"
        config={{ items: 'a,b', mapping: { value: '{{item}}' } }}
        tools={tools}
        onUpdate={onUpdate}
      />,
    )

    fireEvent.change(screen.getByLabelText('Processing mode'), { target: { value: 'for_each' } })
    expect(onUpdate).toHaveBeenLastCalledWith({
      items: 'a,b',
      mapping: { value: '{{item}}' },
      mode: 'for_each',
      tool: 'text.uppercase',
      input: { value: '{{item}}' },
      concurrency: 4,
      toleratedFailureCount: 0,
    })
  })

  it('authors tool, concurrency, and one mutually exclusive failure budget', () => {
    const onUpdate = vi.fn()
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="batch"
        type="loop"
        config={{
          mode: 'for_each',
          items: '{{context.input.customers}}',
          tool: 'text.uppercase',
          input: { value: '{{item.name}}' },
          concurrency: 4,
          toleratedFailureCount: 2,
        }}
        tools={tools}
        onUpdate={onUpdate}
      />,
    )

    expect(screen.getByTestId('loop-for-each-config')).toBeVisible()
    expect(screen.getByLabelText('Tool')).toHaveValue('text.uppercase')
    expect(screen.getByLabelText('Concurrency')).toHaveValue(4)
    expect(screen.getByLabelText('Failed items allowed')).toHaveValue(2)
    expect(screen.getByText(/Processes at most 1,000 items/)).toBeVisible()

    fireEvent.change(screen.getByLabelText('Failure budget'), { target: { value: 'percentage' } })
    expect(onUpdate).toHaveBeenLastCalledWith({
      mode: 'for_each',
      items: '{{context.input.customers}}',
      tool: 'text.uppercase',
      input: { value: '{{item.name}}' },
      concurrency: 4,
      toleratedFailurePercentage: 0,
    })
  })

  it('renders the complete authoring contract in Spanish', () => {
    initI18n('es')
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="batch"
        type="loop"
        config={{ mode: 'for_each', items: 'a,b', tool: 'text.uppercase', input: { value: '{{item}}' }, concurrency: 4, toleratedFailureCount: 0 }}
        tools={tools}
        onUpdate={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Modo de procesamiento')).toHaveValue('for_each')
    expect(screen.getByLabelText('Concurrencia')).toHaveValue(4)
    expect(screen.getByText(/Procesa hasta 1.000 elementos/)).toBeVisible()
  })
})

describe('<QuickConfigEditor /> guided workflow choices', () => {
  it('selects another active workflow by name while excluding the current flow', () => {
    const onUpdate = vi.fn()
    const { container } = render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
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
        {...emptyWorkflowGraph}
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
        {...emptyWorkflowGraph}
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

  it('pins an exact child version and clears back to latest without leaving a stale key', () => {
    const onUpdate = vi.fn()
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="child-flow"
        type="subworkflow"
        config={{ workflowId: 'child', version: 2 }}
        tools={[]}
        workflows={[{ id: 'child', name: 'Child flow' }]}
        onUpdate={onUpdate}
      />,
    )

    const version = screen.getByLabelText('Version pin')
    expect(version).toHaveValue(2)
    expect(screen.getByText('Pinned to exact version v2. Clear the field to follow latest.')).toBeInTheDocument()

    fireEvent.change(version, { target: { value: '3' } })
    // Valid drafts reach the workflow store immediately so Cmd/Ctrl+S while
    // the field retains focus cannot persist the previous pin.
    expect(onUpdate).toHaveBeenLastCalledWith({ workflowId: 'child', version: 3 })

    fireEvent.change(version, { target: { value: '' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ workflowId: 'child' })
  })

  it('rejects a malformed version locally and clears the pin when the child workflow changes', () => {
    const onUpdate = vi.fn()
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="child-flow"
        type="subworkflow"
        config={{ workflowId: 'child-a', version: 4 }}
        tools={[]}
        workflows={[
          { id: 'child-a', name: 'Child A' },
          { id: 'child-b', name: 'Child B' },
        ]}
        onUpdate={onUpdate}
      />,
    )

    const version = screen.getByLabelText('Version pin')
    fireEvent.change(version, { target: { value: '1.5' } })
    fireEvent.blur(version)
    expect(version).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Enter a whole version number between 1 and 2,147,483,647.')).toBeInTheDocument()
    expect(onUpdate).toHaveBeenLastCalledWith({ workflowId: 'child-a', version: '1.5' })

    fireEvent.change(screen.getByLabelText('Workflow id'), { target: { value: 'child-b' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ workflowId: 'child-b' })
  })
})

describe('<QuickConfigEditor /> bounded waiting', () => {
  it('renders approval ownership and deadline policy without duplicating the message field', () => {
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="approval-step"
        type="approval"
        config={{
          message: 'Approve the refund',
          assignee: 'operator-1',
          decisionTimeoutMs: 600_000,
          onTimeout: 'escalate',
          escalateTo: 'operator-2',
        }}
        tools={[]}
        workflowNodes={[]}
        workflowEdges={[]}
        onUpdate={vi.fn()}
      />,
    )

    expect(screen.getAllByLabelText('Approval message')).toHaveLength(1)
    expect(screen.getByLabelText('Responsible user ID')).toHaveValue('operator-1')
    expect(screen.getByLabelText('Decision deadline')).toHaveValue('timeout')
    expect(screen.getByLabelText('Timeout (seconds)')).toHaveValue(600)
    expect(screen.getByLabelText('When the deadline passes')).toHaveValue('escalate')
    expect(screen.getByLabelText('Escalate to user ID')).toHaveValue('operator-2')
  })

  it('clears deadline-only keys while preserving approval content', () => {
    const onUpdate = vi.fn()
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="approval-step"
        type="approval"
        config={{ message: 'Approve', assignee: 'operator-1', decisionTimeoutMs: 60_000, onTimeout: 'auto_reject' }}
        tools={[]}
        workflowNodes={[]}
        workflowEdges={[]}
        onUpdate={onUpdate}
      />,
    )

    fireEvent.change(screen.getByLabelText('Decision deadline'), { target: { value: 'none' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ message: 'Approve', assignee: 'operator-1' })
  })

  it('renders and edits non-minute approval deadlines without changing their precision', () => {
    const onUpdate = vi.fn()
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="approval-step"
        type="approval"
        config={{ decisionTimeoutMs: 90_001 }}
        tools={[]}
        workflowNodes={[]}
        workflowEdges={[]}
        onUpdate={onUpdate}
      />,
    )

    const timeout = screen.getByLabelText('Timeout (seconds)')
    expect(timeout).toHaveValue(90.001)
    fireEvent.change(timeout, { target: { value: '1.234' } })
    fireEvent.blur(timeout)
    expect(onUpdate).toHaveBeenLastCalledWith({ decisionTimeoutMs: 1_234 })
  })

  it('switches wait_until between mutually exclusive duration and absolute modes', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-14T12:00:00Z'))
    const onUpdate = vi.fn()
    const view = render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="wait-step"
        type="wait_until"
        config={{ duration: 'PT5M' }}
        tools={[]}
        workflowNodes={[]}
        workflowEdges={[]}
        onUpdate={onUpdate}
      />,
    )

    fireEvent.change(screen.getByLabelText('Wait mode'), { target: { value: 'until' } })
    expect(onUpdate).toHaveBeenLastCalledWith({ until: '2026-07-14T13:00:00.000Z' })

    view.rerender(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="wait-step"
        type="wait_until"
        config={{ until: '2026-07-14T13:00:00.000Z' }}
        tools={[]}
        workflowNodes={[]}
        workflowEdges={[]}
        onUpdate={onUpdate}
      />,
    )
    expect(screen.getByLabelText('Wait mode')).toHaveValue('until')
    expect(screen.getByLabelText('Resume at')).toHaveAttribute('type', 'datetime-local')
    expect(screen.getByLabelText('Resume at')).toHaveAttribute('step', '0.001')
    expect(screen.getByLabelText('Resume at')).toHaveAccessibleDescription(expect.stringContaining('timezone'))
  })

  it('rejects local wall times skipped by a daylight-saving transition', () => {
    const previousTimeZone = process.env.TZ
    process.env.TZ = 'America/New_York'
    const onUpdate = vi.fn()
    try {
      render(
        <QuickConfigEditor
        {...emptyWorkflowGraph}
          nodeId="wait-step"
          type="wait_until"
          config={{ until: '2026-03-08T06:30:00.000Z' }}
          tools={[]}
          workflowNodes={[]}
          workflowEdges={[]}
          onUpdate={onUpdate}
        />,
      )

      const input = screen.getByLabelText('Resume at')
      fireEvent.change(input, { target: { value: '2026-03-08T02:30:00.000' } })
      fireEvent.blur(input)
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('alert')).toHaveTextContent('daylight-saving transition')
      expect(onUpdate).not.toHaveBeenCalled()
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimeZone
    }
  })

  it('preserves an existing repeated wall time and rejects newly authored daylight-saving overlaps', () => {
    const previousTimeZone = process.env.TZ
    process.env.TZ = 'America/New_York'
    const onUpdate = vi.fn()
    try {
      const view = render(
        <QuickConfigEditor
        {...emptyWorkflowGraph}
          nodeId="wait-step"
          type="wait_until"
          config={{ until: '2026-11-01T06:30:00.000Z' }}
          tools={[]}
          workflowNodes={[]}
          workflowEdges={[]}
          onUpdate={onUpdate}
        />,
      )

      const input = screen.getByLabelText('Resume at')
      expect(input).toHaveValue('2026-11-01T01:30')
      fireEvent.blur(input)
      expect(onUpdate).not.toHaveBeenCalled()

      view.rerender(
        <QuickConfigEditor
        {...emptyWorkflowGraph}
          nodeId="wait-step"
          type="wait_until"
          config={{ until: '2026-11-01T04:30:00.000Z' }}
          tools={[]}
          workflowNodes={[]}
          workflowEdges={[]}
          onUpdate={onUpdate}
        />,
      )
      fireEvent.change(input, { target: { value: '2026-11-01T01:30:00.000' } })
      fireEvent.blur(input)
      expect(input).toHaveAttribute('aria-invalid', 'true')
      expect(screen.getByRole('alert')).toHaveTextContent('skipped or repeated')
      expect(onUpdate).not.toHaveBeenCalled()
    } finally {
      if (previousTimeZone === undefined) delete process.env.TZ
      else process.env.TZ = previousTimeZone
    }
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
        {...emptyWorkflowGraph}
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
        {...emptyWorkflowGraph}
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

describe('<QuickConfigEditor /> inbound webhook trigger', () => {
  it('edits the endpoint selector used by the authenticated ingestion route', () => {
    const onUpdate = vi.fn()
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="incoming"
        type="webhook_received"
        config={{ endpointKey: 'incident-triage' }}
        tools={[]}
        onUpdate={onUpdate}
      />,
    )

    const endpointKey = screen.getByLabelText('Endpoint key')
    expect(endpointKey).toHaveValue('incident-triage')
    expect(screen.getByText(/stable eventId/)).toBeInTheDocument()
    fireEvent.change(endpointKey, { target: { value: 'model-rollout' } })

    expect(onUpdate).toHaveBeenLastCalledWith({ endpointKey: 'model-rollout' })
  })
})

describe('<QuickConfigEditor /> PagerDuty workflow trigger', () => {
  it('uses the normal Inspector for the signing credential and derived callback', () => {
    const onUpdate = vi.fn()
    render(
      <QuickConfigEditor
        {...emptyWorkflowGraph}
        nodeId="on_pagerduty"
        type="pagerduty_incident"
        config={{ webhookCredential: 'pagerduty-webhook', rateLimitPerMin: 120 }}
        tools={[]}
        currentWorkflowId="pagerduty-off-hours"
        onUpdate={onUpdate}
      />,
    )

    expect(screen.getByLabelText('Webhook signing credential')).toHaveValue('pagerduty-webhook')
    expect(screen.getByLabelText('PagerDuty callback URL')).toHaveValue(
      'http://localhost:7311/webhooks/pagerduty/pagerduty-off-hours/on_pagerduty',
    )
    expect(screen.getByLabelText('Maximum events per minute')).toHaveValue(120)
    expect(screen.getByText(/Store the PagerDuty V3 webhook secret/)).toBeVisible()

    fireEvent.change(screen.getByLabelText('Webhook signing credential'), {
      target: { value: 'pagerduty-signing-prod' },
    })
    expect(onUpdate).toHaveBeenLastCalledWith({
      webhookCredential: 'pagerduty-signing-prod',
      rateLimitPerMin: 120,
    })
  })
})
