import { useCallback } from 'react'
import { api } from '../api'
import type { ActiveTab } from '../types'
import type { AppCommandsOptions } from './app-command-types'

type IntegrationCommandDependencies = {
  openRecoveryQueue: (deadLetterId?: string) => void
  openRun: (id: string, targetTab?: ActiveTab) => Promise<void>
  openWorkflow: (id: string) => Promise<boolean>
}

export function useIntegrationCommands(
  options: AppCommandsOptions,
  dependencies: IntegrationCommandDependencies,
) {
  const {
    store,
    refreshPlatform,
    runPlatformMutation,
    t,
  } = options
  const { bumpPlatformVersion } = store
  const { openRecoveryQueue, openRun, openWorkflow } = dependencies

  const installPlugin = useCallback(async (pluginId: string) => {
    await runPlatformMutation({
      request: () => api('/plugins/install', {
        method: 'POST',
        body: JSON.stringify({ pluginId, config: {} }),
      }),
      failureMessage: t('toasts.installFailed'),
      successToast: { message: t('toasts.installSucceeded', { pluginId }), tone: 'success' },
      successToastTiming: 'before-effect',
      onSuccess: refreshPlatform,
    })
  }, [refreshPlatform, runPlatformMutation, t])

  const createCredential = useCallback(async (credential: {
    name: string
    kind: string
    secretValue?: string
    secretRef?: string
    expiresAt?: string
  }): Promise<boolean> => {
    const result = await runPlatformMutation({
      request: () => api('/credentials', {
        method: 'POST',
        body: JSON.stringify(credential),
      }),
      failureMessage: t('toasts.credentialFailed'),
      successToast: {
        message: t('toasts.credentialAdded', { name: credential.name }),
        tone: 'success',
      },
      successToastTiming: 'before-effect',
      onSuccess: refreshPlatform,
    })
    return result.ok
  }, [refreshPlatform, runPlatformMutation, t])

  const installPack = useCallback(async (packId: string) => {
    await runPlatformMutation<{ workflowId?: string; missingCredentials?: unknown[] }>({
      request: () => api('/workflows/import-pack', {
        method: 'POST',
        body: JSON.stringify({ packId }),
      }) as Promise<{ workflowId?: string; missingCredentials?: unknown[] }>,
      failureMessage: t('packs.toast.installFailed'),
      successToast: (result) => {
        const missing = Array.isArray(result.missingCredentials)
          ? result.missingCredentials.length
          : 0
        return {
          message: missing > 0
            ? t('packs.toast.installedWithMissing', { count: missing })
            : t('packs.toast.installed'),
          tone: missing > 0 ? 'info' : 'success',
        }
      },
      successToastTiming: 'before-effect',
      onSuccess: async (result) => {
        bumpPlatformVersion()
        await refreshPlatform()
        if (result.workflowId) await openWorkflow(result.workflowId)
      },
    })
  }, [bumpPlatformVersion, openWorkflow, refreshPlatform, runPlatformMutation, t])

  const sampleRunPack = useCallback(async (packId: string) => {
    await runPlatformMutation<{ runId?: string }>({
      request: () => api(
        `/solution-packs/${encodeURIComponent(packId)}/sample-run`,
        { method: 'POST', body: JSON.stringify({}) },
      ) as Promise<{ runId?: string }>,
      failureMessage: t('packs.toast.sampleFailed'),
      successToast: { message: t('packs.toast.sampleStarted'), tone: 'success' },
      successToastTiming: 'before-effect',
      onSuccess: async (result) => {
        bumpPlatformVersion()
        await refreshPlatform()
        if (result.runId) await openRun(result.runId, 'runs')
      },
    })
  }, [bumpPlatformVersion, openRun, refreshPlatform, runPlatformMutation, t])

  const injectPackFailure = useCallback(async (packId: string, fixtureId: string) => {
    await runPlatformMutation<{ deadLetterId?: string }>({
      request: () => api(
        `/solution-packs/${encodeURIComponent(packId)}/inject-failure`,
        { method: 'POST', body: JSON.stringify({ fixtureId }) },
      ) as Promise<{ deadLetterId?: string }>,
      failureMessage: t('packs.toast.injectFailed'),
      successToast: { message: t('packs.toast.failureInjected'), tone: 'success' },
      successToastTiming: 'before-effect',
      onSuccess: async (result) => {
        bumpPlatformVersion()
        await refreshPlatform()
        openRecoveryQueue(result.deadLetterId)
      },
    })
  }, [bumpPlatformVersion, openRecoveryQueue, refreshPlatform, runPlatformMutation, t])

  return {
    createCredential,
    injectPackFailure,
    installPack,
    installPlugin,
    sampleRunPack,
  }
}
