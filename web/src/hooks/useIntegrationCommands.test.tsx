import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { useWorkflowStore } from '../store'
import type { AppCommandsOptions } from './app-command-types'
import { useIntegrationCommands } from './useIntegrationCommands'
import { usePlatformMutation } from './usePlatformMutation'

vi.mock('../api', () => ({
  api: vi.fn(),
}))

function renderCommands() {
  const refreshPlatform = vi.fn(async () => {})
  const bumpPlatformVersion = vi.fn()
  const addCredential = vi.fn()
  const { result } = renderHook(() => useIntegrationCommands({
    store: { bumpPlatformVersion },
    refreshPlatform,
    addCredential,
    runPlatformMutation: usePlatformMutation(),
    t: (key: string, options?: { name?: string }) => (options?.name ? `${key}:${options.name}` : key),
  } as unknown as AppCommandsOptions, {
    openRecoveryQueue: vi.fn(),
    openRun: vi.fn(async () => {}),
    openWorkflow: vi.fn(async () => true),
  }))
  return { result, refreshPlatform, bumpPlatformVersion, addCredential }
}

const initialStore = useWorkflowStore.getState()

beforeEach(() => {
  vi.mocked(api).mockReset()
  useWorkflowStore.setState({ ...initialStore, toasts: [] }, true)
})

describe('createCredential', () => {
  it('lists the new credential before the refresh, which can fail or lose to a newer one', async () => {
    vi.mocked(api).mockResolvedValue({ id: 'cred-1' })
    const { result, refreshPlatform, addCredential } = renderCommands()
    refreshPlatform.mockImplementation(async () => {
      expect(addCredential).toHaveBeenCalledTimes(1)
    })

    await expect(result.current.createCredential({
      name: 'ops_slack',
      kind: 'slack_webhook',
      secretRef: 'OPS_SLACK',
    })).resolves.toBe(true)

    expect(addCredential).toHaveBeenCalledWith({
      id: 'cred-1',
      name: 'ops_slack',
      kind: 'slack_webhook',
      storage: 'environment',
      expiresAt: null,
    })
    expect(refreshPlatform).toHaveBeenCalledTimes(1)
  })

  it('refreshes after a failed create and lists nothing, so a stale row can correct itself', async () => {
    vi.mocked(api).mockRejectedValue(new Error('Credential name already exists'))
    const { result, refreshPlatform, addCredential } = renderCommands()

    await expect(result.current.createCredential({
      name: 'ops_slack',
      kind: 'slack_webhook',
      secretValue: 'hunter2',
    })).resolves.toBe(false)

    expect(refreshPlatform).toHaveBeenCalledTimes(1)
    expect(addCredential).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().toasts.at(-1)).toMatchObject({ tone: 'error' })
  })
})

describe('revokeCredential', () => {
  it('encodes the name, reloads the inventory, and reports success', async () => {
    vi.mocked(api).mockResolvedValue({ ok: true })
    const { result, refreshPlatform, bumpPlatformVersion } = renderCommands()

    await expect(result.current.revokeCredential('team/a b&c')).resolves.toBe(true)

    expect(api).toHaveBeenCalledWith('/credentials/team%2Fa%20b%26c', { method: 'DELETE' })
    expect(bumpPlatformVersion).toHaveBeenCalledTimes(1)
    expect(refreshPlatform).toHaveBeenCalledTimes(1)
    expect(useWorkflowStore.getState().toasts.at(-1)).toMatchObject({
      message: 'rightPanel.credentials.revokeDone:team/a b&c',
      tone: 'success',
    })
  })

  it('reports a failure without reloading', async () => {
    vi.mocked(api).mockRejectedValue(new Error('Revoking credential failed'))
    const { result, refreshPlatform } = renderCommands()

    await expect(result.current.revokeCredential('demo-slack')).resolves.toBe(false)

    expect(refreshPlatform).not.toHaveBeenCalled()
    expect(useWorkflowStore.getState().toasts.at(-1)).toMatchObject({
      message: 'Revoking credential failed',
      tone: 'error',
    })
  })
})
