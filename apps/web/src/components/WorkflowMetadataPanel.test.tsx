import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

const storeState = vi.hoisted(() => ({
  addToast: vi.fn(),
  bumpPlatformVersion: vi.fn(),
  platformVersion: 1,
  currentWorkflowId: null,
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

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => cleanup())

describe('WorkflowMetadataPanel', () => {
  it('clears stale values when loading metadata for the next workflow fails', async () => {
    apiMock
      .mockResolvedValueOnce({
        workflowId: 'wf-1',
        metadata: {
          owners: ['alice'],
          runbookMarkdown: '# Runbook',
          description: 'Old workflow',
          tags: ['billing'],
          slackChannel: '#ops',
          linearProject: 'acme/ops',
          severityDefault: 'p1',
        },
      })
      .mockRejectedValueOnce(new Error('boom'))

    const { getByTestId, rerender } = render(<WorkflowMetadataPanel workflowId="wf-1" />)

    await waitFor(() => {
      expect((getByTestId('workflow-metadata-owners') as HTMLInputElement).value).toBe('alice')
    })

    rerender(<WorkflowMetadataPanel workflowId="wf-2" />)

    await waitFor(() => {
      expect((getByTestId('workflow-metadata-owners') as HTMLInputElement).value).toBe('')
    })
    expect((getByTestId('workflow-metadata-runbook') as HTMLTextAreaElement).value).toBe('')
  })
})
