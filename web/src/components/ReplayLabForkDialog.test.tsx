import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from '../api'
import { __resetBumpCoalesceForTests, useWorkflowStore } from '../store'
import { ReplayLabForkDialog } from './ReplayLabForkDialog'

vi.mock('../api', async (importOriginal) => {
  // ApiError is a real class consumers throw — keep the implementation
  // but stub the `api` fetch helper.
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, api: vi.fn() }
})

const initialState = useWorkflowStore.getState()

const sourceRun = {
  id: 'src-run-id',
  status: 'failed',
  createdAt: '2026-05-12T00:00:00.000Z',
}

const forkResponse = { runId: 'fork-run-id', predecessorCount: 2 }

describe('<ReplayLabForkDialog />', () => {
  beforeEach(() => {
    // Cancel any pending bumpPlatformVersion timer left by a prior
    // test so the 100ms debounce can't bleed across cases.
    __resetBumpCoalesceForTests()
    vi.mocked(api).mockReset()
    useWorkflowStore.setState({ ...initialState, runId: null, platformVersion: 0, toasts: [] }, true)
  })

  it('renders idle state with source run, fork node, and an empty override textarea', () => {
    render(
      <ReplayLabForkDialog
        sourceRun={sourceRun}
        forkNodeId="node-3"
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { name: /Fork at node-3/i })).toBeInTheDocument()
    expect(screen.getByText('src-run-id')).toBeInTheDocument()
    expect(screen.getByText('node-3')).toBeInTheDocument()
    const textarea = screen.getByTestId('replay-lab-fork-override') as HTMLTextAreaElement
    expect(textarea.value).toBe('')
    expect(screen.getByTestId('replay-lab-fork-submit')).toBeEnabled()
  })

  it('POSTs without an inputOverride field when the textarea is empty, then redirects to the fork run', async () => {
    vi.mocked(api).mockResolvedValueOnce(forkResponse)
    const onClose = vi.fn()
    render(
      <ReplayLabForkDialog
        sourceRun={sourceRun}
        forkNodeId="node-3"
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('replay-lab-fork-submit'))

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1)
    })

    // POST body has sourceRunId + forkNodeId but NOT inputOverride.
    const calls = vi.mocked(api).mock.calls
    expect(calls[0]?.[0]).toBe('/runs/replay-lab/fork')
    const body = JSON.parse((calls[0]?.[1]?.body ?? '{}') as string)
    expect(body).toEqual({ sourceRunId: 'src-run-id', forkNodeId: 'node-3' })

    // Store side effects fired: active run id switched + platform version bumped.
    expect(useWorkflowStore.getState().runId).toBe('fork-run-id')
    // bumpPlatformVersion is debounced (100ms trailing edge) — assert
    // via waitFor so the timer fires under real wallclock during the
    // poll window.
    await waitFor(() => expect(useWorkflowStore.getState().platformVersion).toBe(1))
  })

  it('parses the textarea as JSON and forwards it as inputOverride when valid', async () => {
    vi.mocked(api).mockResolvedValueOnce(forkResponse)
    render(
      <ReplayLabForkDialog
        sourceRun={sourceRun}
        forkNodeId="node-3"
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByTestId('replay-lab-fork-override'), {
      target: { value: '{"foo":"bar","count":42}' },
    })
    fireEvent.click(screen.getByTestId('replay-lab-fork-submit'))

    await waitFor(() => {
      expect(vi.mocked(api)).toHaveBeenCalled()
    })

    const body = JSON.parse((vi.mocked(api).mock.calls[0]?.[1]?.body ?? '{}') as string)
    expect(body).toEqual({
      sourceRunId: 'src-run-id',
      forkNodeId: 'node-3',
      inputOverride: { foo: 'bar', count: 42 },
    })
  })

  it('blocks submit and surfaces an inline error when the override parses to null / primitive / array', async () => {
    render(
      <ReplayLabForkDialog
        sourceRun={sourceRun}
        forkNodeId="node-3"
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByTestId('replay-lab-fork-override'), {
      target: { value: 'null' },
    })
    fireEvent.click(screen.getByTestId('replay-lab-fork-submit'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/must be a JSON object/i)
    })
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })

  it('blocks submit and surfaces an inline error when the override exceeds the 64 KiB cap', async () => {
    render(
      <ReplayLabForkDialog
        sourceRun={sourceRun}
        forkNodeId="node-3"
        onClose={vi.fn()}
      />,
    )

    // 70 KB padding string — over the 64 KB cap. The parse step never
    // runs because the byte-length pre-flight short-circuits.
    const bigValue = 'x'.repeat(70_000)
    fireEvent.change(screen.getByTestId('replay-lab-fork-override'), {
      target: { value: `{"pad":"${bigValue}"}` },
    })
    fireEvent.click(screen.getByTestId('replay-lab-fork-submit'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/exceeds 64 KiB cap/i)
    })
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })

  it('blocks submit and surfaces an inline error when the textarea is not valid JSON', async () => {
    render(
      <ReplayLabForkDialog
        sourceRun={sourceRun}
        forkNodeId="node-3"
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByTestId('replay-lab-fork-override'), {
      target: { value: '{ not valid json' },
    })
    fireEvent.click(screen.getByTestId('replay-lab-fork-submit'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/not valid JSON/i)
    })
    // Parse error short-circuits the POST.
    expect(vi.mocked(api)).not.toHaveBeenCalled()
  })

  it('surfaces a translated message when the server returns a typed error code', async () => {
    vi.mocked(api).mockRejectedValueOnce(
      new ApiError('Fork node not found', { code: 'fork_node_not_found', statusCode: 422 }),
    )
    render(
      <ReplayLabForkDialog
        sourceRun={sourceRun}
        forkNodeId="node-3"
        onClose={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByTestId('replay-lab-fork-submit'))

    await waitFor(() => {
      // The catalog entry resolves to "Fork node not found in this workflow"
      // (apiErrors.fork_node_not_found).
      expect(screen.getByRole('alert')).toHaveTextContent(/fork node not found/i)
    })
    // The dialog is still mounted (no setRunId call); operator can close + reopen.
    expect(useWorkflowStore.getState().runId).toBeNull()
  })

  it('does not redirect when the dialog unmounts mid-POST', async () => {
    let resolveApi: (value: unknown) => void = () => { throw new Error('fork request did not start') }
    vi.mocked(api).mockImplementationOnce(
      () => new Promise((resolve) => { resolveApi = resolve }),
    )
    const onClose = vi.fn()
    const { unmount } = render(
      <ReplayLabForkDialog
        sourceRun={sourceRun}
        forkNodeId="node-3"
        onClose={onClose}
      />,
    )

    fireEvent.click(screen.getByTestId('replay-lab-fork-submit'))
    unmount()
    // Resolve the POST after unmount — the aliveRef guard prevents
    // setRunId / bumpPlatformVersion / onClose from firing.
    resolveApi(forkResponse)
    await Promise.resolve()
    await Promise.resolve()

    expect(useWorkflowStore.getState().runId).toBeNull()
    expect(onClose).not.toHaveBeenCalled()
  })
})
