import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, ApiError } from '../api'
import { useWorkflowStore } from '../store'
import { RerunStepDialog } from './RerunStepDialog'

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, api: vi.fn() }
})

const plan = {
  input: { url: 'https://old.example', method: 'GET', headers: { Authorization: '[redacted]' } },
  reused: ['trigger', 'shape'],
  rerun: ['call', 'notify'],
  notRun: ['audit'],
  sideEffects: [{ nodeId: 'notify', type: 'tool' }],
}
const initialState = useWorkflowStore.getState()
const body = (call: number) => JSON.parse(String(vi.mocked(api).mock.calls[call]?.[1]?.body))

async function open(onClose = vi.fn()) {
  vi.mocked(api).mockResolvedValueOnce(plan)
  render(<RerunStepDialog runId="run-1" nodeId="call" onClose={onClose} />)
  return screen.findByTestId('rerun-input') as Promise<HTMLTextAreaElement>
}

describe('<RerunStepDialog />', () => {
  beforeEach(() => {
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, runId: null, toasts: [] }, true)
  })

  it('shows the input beside the edit, what is reused, and the side effects before confirming', async () => {
    const input = await open()

    expect(vi.mocked(api).mock.calls[0]?.[0]).toBe('/runs/rerun/preview')
    expect(body(0)).toEqual({ sourceRunId: 'run-1', nodeId: 'call' })
    expect(input.value).toContain('https://old.example')
    expect(screen.getByText('Original input').parentElement).toHaveTextContent('https://old.example')
    expect(screen.getByText('Reuse saved outputs').parentElement).toHaveTextContent('trigger, shape')
    expect(screen.getByText('Run again').parentElement).toHaveTextContent('call, notify')
    expect(screen.getByText('Not run').parentElement).toHaveTextContent('audit')
    expect(screen.getByTestId('rerun-side-effects')).toHaveTextContent('notify')
    expect(screen.getByTestId('rerun-submit')).toBeEnabled()
  })

  it('submits the edit with the acknowledged side effects and opens the new run', async () => {
    const onClose = vi.fn()
    const input = await open(onClose)
    fireEvent.change(input, { target: { value: '{"url":"https://new.example","method":"GET"}' } })
    vi.mocked(api).mockResolvedValueOnce({ runId: 'run-2' })

    fireEvent.click(screen.getByTestId('rerun-submit'))

    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(vi.mocked(api).mock.calls[1]?.[0]).toBe('/runs/rerun')
    expect(body(1)).toEqual({
      sourceRunId: 'run-1',
      nodeId: 'call',
      inputOverride: { url: 'https://new.example', method: 'GET' },
      acknowledgedSideEffects: ['notify'],
    })
    expect((vi.mocked(api).mock.calls[1]?.[1]?.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy()
    expect(useWorkflowStore.getState().runId).toBe('run-2')
  })

  it('refuses invalid JSON without calling the server', async () => {
    const input = await open()
    fireEvent.change(input, { target: { value: '{oops' } })

    fireEvent.click(screen.getByTestId('rerun-submit'))

    expect(await screen.findByRole('alert')).toHaveTextContent('not valid JSON')
    expect(vi.mocked(api)).toHaveBeenCalledTimes(1)
  })

  it('shows the new list when the edit added a write, and asks again', async () => {
    const onClose = vi.fn()
    await open(onClose)
    vi.mocked(api).mockRejectedValueOnce(new ApiError('confirm', {
      code: 'rerun_side_effects_unconfirmed',
      params: { sideEffects: [{ nodeId: 'call', type: 'http' }, { nodeId: 'notify', type: 'tool' }] },
    }))

    fireEvent.click(screen.getByTestId('rerun-submit'))

    await waitFor(() => expect(screen.getByTestId('rerun-side-effects')).toHaveTextContent('call, notify'))
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByTestId('rerun-submit')).toBeEnabled()
    vi.mocked(api).mockResolvedValueOnce({ runId: 'run-2' })
    fireEvent.click(screen.getByTestId('rerun-submit'))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(body(2).acknowledgedSideEffects).toEqual(['call', 'notify'])
  })

  it('explains a refused preview and a refused start with the localized code', async () => {
    vi.mocked(api).mockRejectedValueOnce(new ApiError('x', { code: 'rerun_needs_approval', params: { nodeId: 'gate' } }))
    render(<RerunStepDialog runId="run-1" nodeId="send" onClose={vi.fn()} />)

    expect(await screen.findByRole('alert')).toHaveTextContent('Rerun from gate')
    expect(screen.getByTestId('rerun-submit')).toBeDisabled()
  })
})
