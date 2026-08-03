import { useCallback, useEffect } from 'react'
import { AuthProvider } from '../auth'
import {
  consumeDeadLetterDeepLink,
  requestRecoveryQueueFocus,
} from '../components/recovery-queue-focus-bus'
import type { ActiveTab } from '../types'
import {
  resolveWorkspaceDestinationTarget,
  type WorkspaceDestination,
} from '../workspace-locations'
import type { AppCommandsOptions } from './app-command-types'
import { useIntegrationCommands } from './useIntegrationCommands'
import { useKeyboardShortcuts } from './useKeyboardShortcuts'
import { useRunCommands } from './useRunCommands'
import { useWorkflowCommands } from './useWorkflowCommands'

export function useAppCommands(options: AppCommandsOptions) {
  const {
    store,
    permissions,
    setActivityRecoveryId,
    setPaletteOpen,
    setShortcutsOpen,
    focusSidebarSearch,
    t,
  } = options
  const {
    addToast,
    clearAuth,
    setActiveTab,
  } = store
  const canReadRuns = permissions.includes('runs.read')
  const canReadDlq = permissions.includes('dlq.read')
  const canWriteWorkflows = permissions.includes('workflows.write')

  const workflowCommands = useWorkflowCommands(options)
  const runCommands = useRunCommands(options, {
    validateWorkflow: workflowCommands.validateWorkflow,
  })

  const openRecoveryQueue = useCallback((deadLetterId?: string) => {
    if (!canReadRuns || !canReadDlq) return
    setActivityRecoveryId(deadLetterId ?? null)
    requestRecoveryQueueFocus(deadLetterId)
    setActiveTab('runs')
  }, [canReadDlq, canReadRuns, setActiveTab, setActivityRecoveryId])

  const openHomeTab = useCallback((tab: ActiveTab) => {
    if (tab === 'recover') {
      openRecoveryQueue()
      return
    }
    setActiveTab(tab)
  }, [openRecoveryQueue, setActiveTab])

  useEffect(() => {
    const deepLink = consumeDeadLetterDeepLink()
    if (deepLink?.deadLetterId && canReadDlq) openRecoveryQueue(deepLink.deadLetterId)
  }, [canReadDlq, openRecoveryQueue])

  const integrationCommands = useIntegrationCommands(options, {
    openRecoveryQueue,
    openRun: runCommands.openRun,
    openWorkflow: workflowCommands.openWorkflow,
  })

  const signOut = useCallback(async () => {
    try {
      await AuthProvider.signOut()
      clearAuth()
      addToast(t('toasts.signedOut'), 'info')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.signOutFailed'), 'error')
    }
  }, [addToast, clearAuth, t])

  const fireSave = useCallback(() => {
    if (canWriteWorkflows) void workflowCommands.saveWorkflow()
  }, [canWriteWorkflows, workflowCommands.saveWorkflow])
  const fireSignOut = useCallback(() => { void signOut() }, [signOut])
  const openWorkspaceDestination = useCallback((destination: WorkspaceDestination) => {
    const target = resolveWorkspaceDestinationTarget(destination, permissions)
    if (target) setActiveTab(target)
  }, [permissions, setActiveTab])
  const togglePalette = useCallback(() => setPaletteOpen(current => !current), [setPaletteOpen])
  const toggleShortcuts = useCallback(
    () => setShortcutsOpen(current => !current),
    [setShortcutsOpen],
  )

  useKeyboardShortcuts({
    onTogglePalette: togglePalette,
    onToggleShortcuts: toggleShortcuts,
    onFocusSidebarSearch: focusSidebarSearch,
    onSave: fireSave,
    onOpenDestination: openWorkspaceDestination,
    onSignOut: fireSignOut,
  })

  return {
    ...workflowCommands,
    ...runCommands,
    ...integrationCommands,
    fireSignOut,
    openHomeTab,
    openRecoveryQueue,
  }
}
