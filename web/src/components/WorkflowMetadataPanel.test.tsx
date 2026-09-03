import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const storeState = vi.hoisted(() => ({
  addToast: vi.fn(),
  bumpPlatformVersion: vi.fn(),
  platformVersion: 1,
  currentWorkflowId: null as string | null,
  currentWorkflowSaved: true,
}))

vi.mock('../store', () => ({
  useWorkflowStore: vi.fn((selector?: (s: typeof storeState) => unknown) => {
    if (typeof selector === 'function') return selector(storeState)
    return storeState
  }),
}))

import { api } from '../api'
import { WorkflowMetadataPanel } from './WorkflowMetadataPanel'

const apiMock = vi.mocked(api)

const LOADED_METADATA = {
  workflowId: 'wf-1',
  metadata: {
    owners: ['alice'],
    runbookMarkdown: '# Runbook',
    aiGuidanceMarkdown: 'Prefer explicit approval gates.',
    description: 'Old workflow',
    tags: ['billing'],
    folder: 'Billing',
    slackChannel: '#ops',
    linearProject: 'acme/ops',
    severityDefault: 'p1',
  },
}

beforeEach(() => {
  vi.clearAllMocks()
  storeState.platformVersion = 1
  storeState.currentWorkflowId = null
  storeState.currentWorkflowSaved = true
})

afterEach(() => cleanup())

describe('WorkflowMetadataPanel', () => {
  it('loads valid metadata and saves the complete edited form', async () => {
    apiMock.mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') return { ok: true }
      return LOADED_METADATA
    })

    render(<WorkflowMetadataPanel workflowId="wf-1" />)

    const guidance = await screen.findByTestId('workflow-metadata-ai-guidance')
    expect(guidance).toHaveValue('Prefer explicit approval gates.')
    expect(apiMock).toHaveBeenNthCalledWith(1, '/workflows/wf-1/metadata', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))

    fireEvent.change(guidance, { target: { value: 'Prefer bounded retries.' } })
    fireEvent.click(screen.getByTestId('workflow-metadata-save'))

    await waitFor(() => expect(apiMock).toHaveBeenCalledWith(
      '/workflows/wf-1/metadata',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('Prefer bounded retries.'),
      }),
    ))
    expect(storeState.addToast).toHaveBeenCalledWith('Workflow metadata saved', 'success')
    expect(storeState.bumpPlatformVersion).toHaveBeenCalledTimes(1)
  })

  it('clears stale values and blocks editing when loading the next workflow fails', async () => {
    apiMock
      .mockResolvedValueOnce(LOADED_METADATA)
      .mockRejectedValueOnce(new Error('boom'))

    const { rerender } = render(<WorkflowMetadataPanel workflowId="wf-1" />)

    const owners = await screen.findByTestId('workflow-metadata-owners')
    expect(owners).toHaveValue('alice')
    expect(screen.getByTestId('workflow-metadata-ai-guidance')).toHaveValue('Prefer explicit approval gates.')

    rerender(<WorkflowMetadataPanel workflowId="wf-2" />)

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument())
    expect(owners).toHaveValue('')
    expect(screen.getByTestId('workflow-metadata-runbook')).toHaveValue('')
    expect(screen.getByTestId('workflow-metadata-ai-guidance')).toHaveValue('')
    expect(owners).toBeDisabled()
    expect(screen.getByTestId('workflow-metadata-save')).toBeDisabled()
    expect(apiMock).toHaveBeenNthCalledWith(2, '/workflows/wf-2/metadata', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))
  })

  it('blocks a malformed initial envelope and recovers through a fresh retry', async () => {
    apiMock
      .mockResolvedValueOnce({ metadata: 'not-an-object' })
      .mockResolvedValueOnce(LOADED_METADATA)

    render(<WorkflowMetadataPanel workflowId="wf-1" />)

    const guidance = await screen.findByTestId('workflow-metadata-ai-guidance')
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load workflow metadata."))
    expect(guidance).toBeDisabled()
    expect(screen.getByTestId('workflow-metadata-save')).toBeDisabled()

    fireEvent.click(screen.getByTestId('workflow-metadata-retry'))

    await waitFor(() => expect(guidance).toBeEnabled())
    expect(guidance).toHaveValue('Prefer explicit approval gates.')
    expect(apiMock).toHaveBeenNthCalledWith(2, '/workflows/wf-1/metadata', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }))
  })

  it('preserves an unsaved draft across unrelated platform invalidations', async () => {
    apiMock
      .mockResolvedValueOnce(LOADED_METADATA)
      .mockResolvedValueOnce({
        ...LOADED_METADATA,
        metadata: { ...LOADED_METADATA.metadata, aiGuidanceMarkdown: 'Server changed elsewhere.' },
      })

    const { rerender } = render(<WorkflowMetadataPanel workflowId="wf-1" />)
    const guidance = await screen.findByTestId('workflow-metadata-ai-guidance')
    fireEvent.change(guidance, { target: { value: 'Unsaved workflow draft.' } })

    storeState.platformVersion = 2
    rerender(<WorkflowMetadataPanel workflowId="wf-1" />)

    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2))
    expect(guidance).toHaveValue('Unsaved workflow draft.')
    expect(screen.getByTestId('workflow-metadata-save')).toBeEnabled()
  })

  it('ignores a pre-save refresh that resolves after the save succeeds', async () => {
    let resolveStaleRefresh!: (value: typeof LOADED_METADATA) => void
    const staleRefresh = new Promise<typeof LOADED_METADATA>((resolve) => {
      resolveStaleRefresh = resolve
    })
    let readCount = 0
    apiMock.mockImplementation(async (_path, init) => {
      if (init?.method === 'POST') return { ok: true }
      readCount += 1
      return readCount === 1 ? LOADED_METADATA : staleRefresh
    })

    const { rerender } = render(<WorkflowMetadataPanel workflowId="wf-1" />)
    const guidance = await screen.findByTestId('workflow-metadata-ai-guidance')

    storeState.platformVersion = 2
    rerender(<WorkflowMetadataPanel workflowId="wf-1" />)
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(2))

    fireEvent.change(guidance, { target: { value: 'Saved while refresh was pending.' } })
    fireEvent.click(screen.getByTestId('workflow-metadata-save'))
    await waitFor(() => expect(storeState.bumpPlatformVersion).toHaveBeenCalledTimes(1))

    await act(async () => resolveStaleRefresh(LOADED_METADATA))
    expect(guidance).toHaveValue('Saved while refresh was pending.')
  })

  it('flags secret-like guidance and blocks the save handler', async () => {
    apiMock.mockResolvedValue(LOADED_METADATA)
    render(<WorkflowMetadataPanel workflowId="wf-1" />)

    const guidance = await screen.findByTestId('workflow-metadata-ai-guidance')
    fireEvent.change(guidance, {
      target: { value: 'Use postgres://operator:super-secret@db.internal/acme' },
    })

    expect(guidance).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('Guidance contains a secret-like value. Remove it before saving.')).toBeInTheDocument()
    expect(screen.getByTestId('workflow-metadata-save')).toBeDisabled()

    fireEvent.submit(screen.getByTestId('workflow-metadata-save').closest('form')!)
    expect(apiMock).toHaveBeenCalledTimes(1)
  })
})
