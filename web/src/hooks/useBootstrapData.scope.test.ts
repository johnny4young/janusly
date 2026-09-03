import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.fn()
vi.mock('../api', () => ({ api: (...args: unknown[]) => apiMock(...args) }))

import { useBootstrapData } from './useBootstrapData'
import { useWorkflowStore } from '../store'

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void }

function deferred(): Deferred {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((done) => { resolve = done })
  return { promise, resolve }
}

describe('useBootstrapData tenant boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drops late responses from the previously selected organization', async () => {
    // An authoring tab is open, so the wave includes the catalogs.
    useWorkflowStore.setState({ activeTab: 'ai-studio' })
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

  it('defers catalog reads until a surface that renders them is opened', async () => {
    useWorkflowStore.setState({ activeTab: 'home' })
    apiMock.mockImplementation((path: string) => Promise.resolve(
      path === '/billing/usage' ? {} : path === '/ai/health' ? { enabled: false }
        : path === '/solution-packs' ? { packs: [] } : [],
    ))
    const permissions = [
      'workflows.read', 'packs.read', 'credentials.read', 'runs.read', 'dlq.read',
    ]
    const { result } = renderHook(() => useBootstrapData('org-home', permissions))

    await waitFor(() => expect(apiMock).toHaveBeenCalled())
    const homePaths = apiMock.mock.calls.map(([path]) => path)
    for (const catalog of ['/tools', '/templates', '/solution-packs', '/credentials']) {
      expect(homePaths).not.toContain(catalog)
    }
    expect(homePaths).toContain('/runs')
    expect(homePaths).toContain('/dlq')

    // Opening an authoring surface latches them back on for the session.
    apiMock.mockClear()
    useWorkflowStore.setState({ activeTab: 'ai-studio' })
    await waitFor(() => expect(apiMock.mock.calls.map(([path]) => path)).toContain('/credentials'))
    const authoringPaths = apiMock.mock.calls.map(([path]) => path)
    for (const catalog of ['/tools', '/templates', '/solution-packs', '/credentials']) {
      expect(authoringPaths).toContain(catalog)
    }

    // And they stay on after returning Home — the data is already loaded.
    apiMock.mockClear()
    useWorkflowStore.setState({ activeTab: 'home' })
    await act(async () => { await result.current.refreshPlatform() })
    expect(apiMock.mock.calls.map(([path]) => path)).toContain('/templates')
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
