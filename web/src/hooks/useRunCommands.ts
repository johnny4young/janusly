import { useCallback } from 'react'
import { api, contractApi } from '../api'
import { requestRecoveryAllClearIfQueueEmpty } from '../components/recovery-all-clear-coordinator'
import { formatStatusLabel } from '../constants'
import { isRunRequestCurrent } from '../run-transition'
import { useWorkflowStore } from '../store'
import type {
  ActiveTab,
  RunEvent,
  RunNode,
  RunSummary,
} from '../types'
import { isTerminalRunStatus } from '@/lib/status'
import type { AppCommandsOptions } from './app-command-types'

type RunResponse = {
  run?: RunSummary
  nodes?: RunNode[]
  events?: RunEvent[]
  eventsCursor?: string | null
  eventsHasMore?: boolean
}

type WorkflowCommands = {
  validateWorkflow: () => Promise<boolean>
}

export function useRunCommands(
  options: AppCommandsOptions,
  workflowCommands: WorkflowCommands,
) {
  const {
    store,
    permissions,
    projectedRuns,
    refreshPlatform,
    projectRunSummary,
    loadStatus,
    runTransitionGuard,
    runPlatformMutation,
    setRunInputOpen,
    setRunInputServerErrors,
    setRunInputSubmitting,
    setActivityRecoveryId,
    t,
  } = options
  const {
    addEvents,
    addToast,
    bumpPlatformVersion,
    currentWorkflowInputs,
    eventsCursor,
    eventsHasMore,
    runId,
    setActiveTab,
    setEvents,
    setEventsPagination,
    setRunDetail,
    setRunId,
    setRunNodes,
  } = store
  const canWriteWorkflows = permissions.includes('workflows.write')
  const canStartRuns = permissions.includes('runs.start')
  const canReadRuns = permissions.includes('runs.read')
  const { validateWorkflow } = workflowCommands

  const startRunWith = useCallback(async (
    input: unknown | undefined,
  ): Promise<{ runId?: string; errors?: string[]; discarded?: true }> => {
    const requestId = runTransitionGuard.begin()
    const current = useWorkflowStore.getState()
    const workflow = current.getWorkflowJson()
    // Only an unchanged canvas may claim an immutable version. The server
    // independently verifies the tenant, parent workflow and canonical DAG;
    // omitting the claim keeps templates and edited drafts explicitly ad hoc.
    const workflowVersionId = !current.workflowDirty
      && current.currentWorkflowVersion
      && current.currentWorkflowId === workflow.id
      ? current.currentWorkflowVersion.id
      : undefined
    const body = {
      workflow,
      ...(workflowVersionId ? { workflowVersionId } : {}),
      ...(input !== undefined ? { input } : {}),
    }
    let result: { runId?: string; errors?: string[] }
    try {
      result = await api('/start', {
        method: 'POST',
        body: JSON.stringify(body),
      }) as { runId?: string; errors?: string[] }
    } catch (error) {
      if (!runTransitionGuard.isCurrent(requestId)) return { discarded: true }
      throw error
    }
    const isCurrentRequest = runTransitionGuard.isCurrent(requestId)
    if (result.errors) return isCurrentRequest ? result : { discarded: true }
    if (!result.runId) {
      if (!isCurrentRequest) return { discarded: true }
      throw new Error(t('toasts.apiNoRunId'))
    }
    if (!isCurrentRequest) {
      bumpPlatformVersion()
      return { discarded: true }
    }
    setRunId(result.runId)
    setRunDetail({
      id: result.runId,
      status: 'running',
      inputJson: { workflow, ...(input !== undefined ? { input } : {}) },
    })
    setActiveTab('runs')
    addToast(t('toasts.runStarted', { runIdShort: result.runId.slice(0, 8) }), 'success')
    bumpPlatformVersion()
    await refreshPlatform()
    return result
  }, [
    addToast,
    bumpPlatformVersion,
    refreshPlatform,
    runTransitionGuard,
    setActiveTab,
    setRunDetail,
    setRunId,
    t,
  ])

  const startWorkflow = useCallback(async () => {
    if (!canStartRuns) return
    if (canWriteWorkflows && !await validateWorkflow()) return
    if (currentWorkflowInputs) {
      setRunInputServerErrors([])
      setRunInputOpen(true)
      return
    }
    try {
      await startRunWith(undefined)
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.runFailedToStart'), 'error')
    }
  }, [
    addToast,
    canStartRuns,
    canWriteWorkflows,
    currentWorkflowInputs,
    setRunInputOpen,
    setRunInputServerErrors,
    startRunWith,
    t,
    validateWorkflow,
  ])

  const submitRunInput = useCallback(async (input: unknown) => {
    setRunInputSubmitting(true)
    setRunInputServerErrors([])
    try {
      const result = await startRunWith(input)
      if (result.discarded) return
      if (result.errors && result.errors.length > 0) {
        setRunInputServerErrors(result.errors)
        return
      }
      setRunInputOpen(false)
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('toasts.runFailedToStart'), 'error')
    } finally {
      setRunInputSubmitting(false)
    }
  }, [
    addToast,
    setRunInputOpen,
    setRunInputServerErrors,
    setRunInputSubmitting,
    startRunWith,
    t,
  ])

  const openRun = useCallback(async (id: string, targetTab?: ActiveTab) => {
    if (!canReadRuns) return
    const requestId = runTransitionGuard.begin()
    setActivityRecoveryId(null)
    setActiveTab(targetTab ?? 'runs')
    try {
      const data = await contractApi('GET /run', `/run?runId=${encodeURIComponent(id)}`, undefined) as unknown as RunResponse
      if (!runTransitionGuard.isCurrent(requestId)) return
      setRunId(id)
      if (data.run) {
        setRunDetail(data.run)
        projectRunSummary(id, data.run)
      }
      setRunNodes(data.nodes ?? [])
      setEvents(data.events ?? [])
      setEventsPagination(data.eventsCursor ?? null, Boolean(data.eventsHasMore))
    } catch (error) {
      if (!runTransitionGuard.isCurrent(requestId)) return
      addToast(error instanceof Error ? error.message : t('toasts.runOpenFailed'), 'error')
    }
  }, [
    addToast,
    canReadRuns,
    projectRunSummary,
    runTransitionGuard,
    setActiveTab,
    setActivityRecoveryId,
    setEvents,
    setEventsPagination,
    setRunDetail,
    setRunId,
    setRunNodes,
    t,
  ])

  const clearActiveRun = useCallback(() => {
    runTransitionGuard.begin()
    setRunId(null)
    setRunDetail(null)
    setRunNodes([])
    setEvents([])
    setEventsPagination(null, false)
  }, [
    runTransitionGuard,
    setEvents,
    setEventsPagination,
    setRunDetail,
    setRunId,
    setRunNodes,
  ])

  const loadOlderEvents = useCallback(async () => {
    if (!runId || !eventsCursor || !eventsHasMore) return
    const context = {
      runId,
      generation: useWorkflowStore.getState().runTransitionGeneration,
    }
    try {
      const data = await contractApi('GET /run', `/run?runId=${encodeURIComponent(runId)}&eventsCursor=${encodeURIComponent(eventsCursor)}`, undefined) as unknown as RunResponse
      if (!isRunRequestCurrent(context, useWorkflowStore.getState())) return
      addEvents(data.events ?? [])
      setEventsPagination(data.eventsCursor ?? null, Boolean(data.eventsHasMore))
    } catch (error) {
      if (!isRunRequestCurrent(context, useWorkflowStore.getState())) return
      addToast(error instanceof Error ? error.message : t('toasts.olderEventsFailed'), 'error')
    }
  }, [
    addEvents,
    addToast,
    eventsCursor,
    eventsHasMore,
    runId,
    setEventsPagination,
    t,
  ])

  const approveNode = useCallback(async (nodeId: string) => {
    if (!runId) return
    await runPlatformMutation({
      request: () => api('/resume', {
        method: 'POST',
        body: JSON.stringify({ runId, nodeId }),
      }),
      failureMessage: t('toasts.resumeFailed'),
      successToast: { message: t('toasts.stepApproved', { nodeId }), tone: 'success' },
      onSuccess: async () => {
        await loadStatus(runId)
      },
    })
  }, [loadStatus, runId, runPlatformMutation, t])

  const submitHumanForm = useCallback(async (
    nodeId: string,
    input: unknown,
    resumeToken: string,
  ) => {
    if (!runId) return [t('toasts.formNoActiveRun')]
    try {
      const result = await api('/resume', {
        method: 'POST',
        body: JSON.stringify({ runId, nodeId, input, resumeToken }),
      }) as { errors?: string[] }
      if (result.errors && result.errors.length > 0) return result.errors
      await loadStatus(runId)
      bumpPlatformVersion()
      await refreshPlatform()
      addToast(t('toasts.formSubmitted', { nodeId }), 'success')
      return undefined
    } catch (error) {
      const message = error instanceof Error ? error.message : t('toasts.formSubmitFailed')
      addToast(message, 'error')
      return [message]
    }
  }, [addToast, bumpPlatformVersion, loadStatus, refreshPlatform, runId, t])

  const replayNode = useCallback(async (nodeId: string) => {
    if (!runId) return
    await runPlatformMutation({
      request: () => api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({ runId, nodeId }),
      }),
      failureMessage: t('toasts.replayFailed'),
      successToast: { message: t('toasts.stepRetried', { nodeId }), tone: 'success' },
      onSuccess: async () => {
        await loadStatus(runId)
        bumpPlatformVersion()
        await refreshPlatform()
      },
    })
  }, [bumpPlatformVersion, loadStatus, refreshPlatform, runId, runPlatformMutation, t])

  const redriveNode = useCallback(async (nodeId: string) => {
    if (!runId) return
    await runPlatformMutation({
      request: () => api('/runs/redrive', {
        method: 'POST',
        body: JSON.stringify({ runId, nodeId }),
      }),
      failureMessage: t('toasts.redriveFailed'),
      successToast: { message: t('toasts.redriveStarted', { nodeId }), tone: 'success' },
      onSuccess: async (result) => {
        bumpPlatformVersion()
        await refreshPlatform()
        const continuation = (result as { runId?: string } | undefined)?.runId
        if (continuation) await openRun(continuation, 'runs')
      },
    })
  }, [bumpPlatformVersion, openRun, refreshPlatform, runId, runPlatformMutation, t])

  const cancelActiveRun = useCallback(async () => {
    if (!runId) return
    const activeRun = projectedRuns.find(run => run.id === runId)
    if (activeRun && isTerminalRunStatus(activeRun.status)) {
      addToast(
        t('toasts.runAlreadyTerminal', { status: formatStatusLabel(activeRun.status) }),
        'info',
      )
      return
    }
    await runPlatformMutation({
      request: () => api('/run/cancel', {
        method: 'POST',
        // The optional reason is operator prose, not provenance. The audit
        // boundary already records who initiated the cancellation.
        body: JSON.stringify({ runId }),
      }),
      failureMessage: t('toasts.runCancelFailed'),
      successToast: { message: t('toasts.runCancelled'), tone: 'success' },
      onSuccess: async () => {
        await loadStatus(runId)
        bumpPlatformVersion()
        await refreshPlatform()
      },
    })
  }, [
    addToast,
    bumpPlatformVersion,
    loadStatus,
    projectedRuns,
    refreshPlatform,
    runId,
    runPlatformMutation,
    t,
  ])

  const replayDeadLetter = useCallback(async (deadLetterId: string) => {
    const result = await runPlatformMutation({
      request: () => api('/dlq/replay', {
        method: 'POST',
        body: JSON.stringify({ deadLetterId }),
      }),
      failureMessage: t('toasts.deadLetterReplayFailed'),
      successToast: { message: t('toasts.deadLetterReplayed'), tone: 'success' },
      onSuccess: async () => {
        if (runId) await loadStatus(runId)
        bumpPlatformVersion()
        await refreshPlatform()
      },
    })
    return result.ok
  }, [bumpPlatformVersion, loadStatus, refreshPlatform, runId, runPlatformMutation, t])

  const resolveDeadLetter = useCallback(async (deadLetterId: string) => {
    const result = await runPlatformMutation({
      request: () => api('/dlq/resolve', {
        method: 'POST',
        body: JSON.stringify({ id: deadLetterId }),
      }),
      failureMessage: t('toasts.deadLetterResolveFailed'),
      successToast: { message: t('toasts.deadLetterResolved'), tone: 'success' },
      onSuccess: async () => {
        bumpPlatformVersion()
        await Promise.all([
          refreshPlatform(),
          requestRecoveryAllClearIfQueueEmpty(),
        ])
      },
    })
    return result.ok
  }, [bumpPlatformVersion, refreshPlatform, runPlatformMutation, t])

  return {
    approveNode,
    cancelActiveRun,
    clearActiveRun,
    loadOlderEvents,
    openRun,
    redriveNode,
    replayDeadLetter,
    replayNode,
    resolveDeadLetter,
    startWorkflow,
    submitHumanForm,
    submitRunInput,
  }
}
