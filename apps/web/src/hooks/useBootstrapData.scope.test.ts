import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.fn()
vi.mock('../api', () => ({ api: (...args: unknown[]) => apiMock(...args) }))

import { useBootstrapData } from './useBootstrapData'

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void }

function deferred(): Deferred {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => { resolve = done })
  return { promise, resolve }
}

describe('useBootstrapData tenant boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drops late responses from the previously selected organization', async () => {
    const firstRequests = Array.from({ length: 9 }, deferred)
    let firstIndex = 0
    let secondScope = false
    apiMock.mockImplementation((path: string) => {
      if (!secondScope) return firstRequests[firstIndex++]!.promise
      if (path === '/workflows') return Promise.resolve([{ id: 'workflow-b', name: 'Beta workflow' }])
      if (path === '/solution-packs') return Promise.resolve({ packs: [] })
      return Promise.resolve(path === '/billing/usage' ? {} : path === '/ai/health' ? { enabled: false } : [])
    })

    const permissions = [
      'workflows.read', 'packs.read', 'credentials.read', 'runs.read', 'dlq.read',
    ]
    const { result, rerender } = renderHook(
      ({ scope }) => useBootstrapData(scope, permissions),
      { initialProps: { scope: 'org-a' as string | null } },
    )
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(9))

    secondScope = true
    rerender({ scope: 'org-b' })
    await waitFor(() => expect(result.current.savedWorkflows).toEqual([{ id: 'workflow-b', name: 'Beta workflow' }]))

    await act(async () => {
      for (const request of firstRequests) request.resolve([])
      await Promise.all(firstRequests.map((request) => request.promise))
    })
    expect(result.current.savedWorkflows).toEqual([{ id: 'workflow-b', name: 'Beta workflow' }])
  })

  it('does not request surfaces excluded by the effective permission set', async () => {
    apiMock.mockImplementation((path: string) => Promise.resolve(
      path === '/billing/usage' ? {} : path === '/ai/health' ? { enabled: false } : [],
    ))
    renderHook(() => useBootstrapData('org-viewer', ['runs.read']))

    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    const paths = apiMock.mock.calls.map(([path]) => path)
    expect(paths).toContain('/runs')
    expect(paths).not.toContain('/credentials')
    expect(paths).not.toContain('/workflows')
    expect(paths).not.toContain('/dlq')
  })
})
