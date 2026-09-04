/**
 * `App` — top-level Janusly Studio shell.
 *
 * Coordinates tenant data, run observation, workflow state, and the render
 * model consumed by `AppWorkspace`. Focused hooks own identity, commands,
 * polling, streaming, and draft persistence.
 *
 * Used by `web/src/main.tsx` — single entry point, single instance.
 *
 * Invariants:
 * - Polling at 1500ms calls `loadStatus(runId)` and merges events via the
 *   Zustand store (`mergeEvents`) — DON'T replace events wholesale or you
 *   re-introduce the timeline-clobber bug.
 * - Terminal-state branch fires `bumpPlatformVersion()` so independent
 *   panels re-fetch (cross-panel reactivity invariant).
 * - Web deps lockdown: only the AGENTS-approved imports plus
 *   `@/lib/status` for zero-dep lifecycle guards. Don't add
 *   radix/cva/clsx/tailwind-merge here.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AppWorkspace } from './AppWorkspace'
import { BrandMark } from './components/BrandMark'
import { Login } from './components/Login'
import { WorkspaceGate } from './components/WorkspaceGate'
import { consumeDeadLetterDeepLink } from './components/recovery-queue-focus-bus'
import { isSupabaseConfigured } from './auth'
import { api } from './api'
import type { RunInputPreset } from './components/RunInputDialog'
import { useWorkflowStore } from './store'
import { useAppStore } from './hooks/useAppStore'
import { useAppCommands } from './hooks/useAppCommands'
import { useIdentityBootstrap } from './hooks/useIdentityBootstrap'
import { useRunEventStream } from './hooks/useRunEventStream'
import { patchRunSummaryList, useBootstrapData } from './hooks/useBootstrapData'
import { useRunPolling } from './hooks/useRunPolling'
import { usePlatformMutation } from './hooks/usePlatformMutation'
import { useDraftAutosave, readLatestDraft } from './hooks/useDraftPersistence'
import { projectVisibleEdges, projectVisibleNodes } from './canvas-projections'
import type { AiAuthoringAction, AiAuthoringActionRequest, AiReviewIssue, ReadinessResult, RunSummary, ValidationIssue, WorkflowGraphEdge, WorkflowGraphNode } from './types'
import { isCanvasTab } from './types'
import { isOpenRunStatus } from '@/lib/status'
import { useT } from './i18n'
import { countActiveRecoveryBlockers } from './components/recovery-center/recovery-center-model'
import { DOCS_URL } from './docs-link'
import { createRunTransitionGuard } from './run-transition'
import { currentSessionOrganization } from './identity-context'
import { canOpenTab, firstOpenTab } from './tab-permissions'

const EMPTY_PERMISSIONS: readonly string[] = Object.freeze([])

export default function App() {
  const appStore = useAppStore()
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    connect,
    addNode,
    activeTab,
    activeRecoveryCaseId,
    userId,
    orgId,
    authReady,
    identityContext,
    identityReady,
    runId,
    runDetail,
    runNodes,
    events,
    selectedNodeId,
    selectedEdgeId,
    currentWorkflowId,
    currentWorkflowName,
    currentWorkflowSaved,
    currentWorkflowVersion,
    currentWorkflowInputs,
    currentWorkflowOutputs,
    workflowRevision,
    streamStatus,
    setAuth,
    clearAuth,
    setAuthReady,
    setIdentityContext,
    setIdentityPending,
    setActiveTab,
    openRecoveryCase,
    setWorkflowName,
    initializeWorkflowName,
    hydrateWorkflow,
    selectNode,
    selectEdge,
    updateSelectedNodeConfig,
    updateSelectedNodeType,
    patchRunDetail,
    eventsHasMore,
    addToast,
    bumpPlatformVersion,
    // Scoped selector (was a selector-less `useWorkflowStore()` that
    // re-rendered the root on EVERY store mutation). With useShallow the App
    // root only re-renders when one of the fields it actually reads changes —
    // unrelated ticks (e.g. platformVersion bumps) no longer re-render it.
  } = appStore

  const { t } = useT()

  useLayoutEffect(() => {
    initializeWorkflowName(t('workflow.defaultName'))
  }, [initializeWorkflowName, t])

  const [validationIssues, setValidationIssues] = useState<ValidationIssue[]>([])
  const [readinessResult, setReadinessResult] = useState<ReadinessResult | null>(null)
  const [aiReviewIssues, setAiReviewIssues] = useState<AiReviewIssue[]>([])
  const handleReadinessResult = useCallback((result: ReadinessResult | null) => {
    setReadinessResult(result)
  }, [])

  // Findings describe one exact serialized graph. Any semantic mutation makes
  // validation/AI review stale immediately; readiness publishes a fresh,
  // debounced result through the header badge. Canvas drags do not increment
  // this revision and therefore preserve the diagnostics.
  useEffect(() => {
    setValidationIssues([])
    setAiReviewIssues([])
    setReadinessResult(null)
  }, [workflowRevision])
  // Server-data bootstrap (tools / templates / packs / credentials / runs /
  // saved workflows / dead letters / usage / ai-health) + the `refreshPlatform`
  // fan-out, fired once `authReady` flips.
  const tenantReady = authReady && identityReady && Boolean(identityContext?.currentOrganizationId)
  const currentOrganization = useMemo(
    () => currentSessionOrganization(identityContext),
    [identityContext],
  )
  const tenantPermissions = currentOrganization?.permissions ?? EMPTY_PERMISSIONS
  const canWriteWorkflows = tenantPermissions.includes('workflows.write')
  const canInstallPacks = tenantPermissions.includes('packs.install')
  const {
    tools,
    templates,
    solutionPacks,
    credentials,
    runs,
    savedWorkflows,
    deadLetters,
    usage,
    aiHealth,
    refreshPlatform,
    patchRunSummary,
    beginRunSummaryUpdate,
  } = useBootstrapData(
    tenantReady ? identityContext?.currentOrganizationId ?? null : null,
    tenantPermissions,
  )

  const projectRunSummary = useCallback((id: string, patch: Partial<RunSummary>) => {
    patchRunSummary(id, patch)
    patchRunDetail(id, patch)
  }, [patchRunDetail, patchRunSummary])

  const beginRunProjectionUpdate = useCallback((id: string) => {
    const commitSummary = beginRunSummaryUpdate(id)
    return (patch: Partial<RunSummary>) => {
      if (!commitSummary(patch)) return false
      patchRunDetail(id, patch)
      return true
    }
  }, [beginRunSummaryUpdate, patchRunDetail])

  // The selected detail is the freshest complete snapshot for its run. Fold it
  // into list consumers so a slower collection refresh cannot make the active
  // card and history row disagree with the observation canvas.
  const projectedRuns = useMemo(
    () => runId && runDetail?.id === runId
      ? patchRunSummaryList(runs, runId, runDetail)
      : runs,
    [runDetail, runId, runs],
  )

  useEffect(() => {
    if (!tenantReady || canOpenTab(activeTab, tenantPermissions)) return
    const fallback = firstOpenTab(tenantPermissions)
    if (fallback) setActiveTab(fallback)
  }, [activeTab, setActiveTab, tenantPermissions, tenantReady])
  // Run-input dialog state. Open when the active workflow declares typed
  // `inputs` and the user presses Run; closed otherwise. Server errors
  // (JSONPath strings) are stored separately so the dialog can surface
  // them next to the right field without losing them in a toast.
  const [runInputOpen, setRunInputOpen] = useState(false)
  const [runInputServerErrors, setRunInputServerErrors] = useState<string[]>([])
  const [runInputSubmitting, setRunInputSubmitting] = useState(false)
  // Named presets load when the dialog opens for a SAVED workflow; unsaved
  // drafts have no server identity to hang presets on, so the seam stays
  // unset and the dialog renders without the preset strip.
  const [runInputPresets, setRunInputPresets] = useState<RunInputPreset[] | undefined>(undefined)
  useEffect(() => {
    if (!runInputOpen || !currentWorkflowSaved || !currentWorkflowId) {
      setRunInputPresets(undefined)
      return
    }
    let cancelled = false
    api(`/workflows/${encodeURIComponent(currentWorkflowId)}/input-presets`)
      .then((response) => {
        if (cancelled) return
        const presets = (response as { presets?: Array<{ name: string; input: unknown }> })?.presets
        setRunInputPresets(Array.isArray(presets)
          ? presets.map((preset) => ({ name: preset.name, input: preset.input }))
          : [])
      })
      .catch(() => {
        if (!cancelled) setRunInputPresets(undefined)
      })
    return () => { cancelled = true }
  }, [runInputOpen, currentWorkflowId, currentWorkflowSaved])
  const saveRunInputPreset = useCallback(async (name: string, input: unknown) => {
    try {
      await api(`/workflows/${encodeURIComponent(currentWorkflowId)}/input-presets`, {
        method: 'PUT', body: JSON.stringify({ name, input }),
      })
      const refreshed = await api(`/workflows/${encodeURIComponent(currentWorkflowId)}/input-presets`) as {
        presets?: Array<{ name: string; input: unknown }>
      }
      setRunInputPresets((refreshed.presets ?? []).map((preset) => ({ name: preset.name, input: preset.input })))
      addToast(t('runInput.presets.saved'), 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('runInput.presets.saveFailed'), 'error')
      throw error
    }
  }, [addToast, currentWorkflowId, t])
  const deleteRunInputPreset = useCallback(async (name: string) => {
    try {
      await api(`/workflows/${encodeURIComponent(currentWorkflowId)}/input-presets/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      })
      setRunInputPresets((current) => current?.filter((preset) => preset.name !== name))
      addToast(t('runInput.presets.deleted'), 'success')
    } catch (error) {
      addToast(error instanceof Error ? error.message : t('runInput.presets.deleteFailed'), 'error')
      throw error
    }
  }, [addToast, currentWorkflowId, t])
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [semanticBlockerRunIds, setSemanticBlockerRunIds] = useState<string[]>([])
  const [activityRecoveryId, setActivityRecoveryId] = useState<string | null>(null)
  const [initialRecoveryDeepLink] = useState(() => consumeDeadLetterDeepLink())
  const recoveryDeepLinkOpened = useRef(false)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  const [snippetMenuOpen, setSnippetMenuOpen] = useState(false)
  const [aiActionRequest, setAiActionRequest] = useState<AiAuthoringActionRequest | null>(null)
  // React Flow cannot establish a valid viewport when its first mount happens
  // under display:none (for example, after reloading on Runs). Defer that first
  // mount until a canvas tab is visible, then retain the instance across other
  // non-home tabs so operator pan/zoom still survives ordinary navigation.
  const [canvasActivated, setCanvasActivated] = useState(() => isCanvasTab(activeTab))

  useEffect(() => {
    setSemanticBlockerRunIds([])
    setActivityRecoveryId(null)
  }, [orgId])
  useEffect(() => {
    if (activeTab === 'home') {
      setCanvasActivated(false)
    } else if (isCanvasTab(activeTab)) {
      setCanvasActivated(true)
    }
  }, [activeTab])
  // Stable references for the overlay close callbacks. Inline arrows here
  // would create a fresh function ref on every App render — polling at 1.5s
  // plus every Zustand mutation would re-bind the Escape keydown listener
  // inside each modal's `useEffect`. useCallback pins the ref.
  const closePalette = useCallback(() => setPaletteOpen(false), [])
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), [])
  const openShortcuts = useCallback(() => setShortcutsOpen(true), [])
  const closeSnippetMenu = useCallback(() => setSnippetMenuOpen(false), [])

  // Stable canvas handlers + palette list so React.memo(WorkflowCanvas) holds
  // and the (expensive) canvas subtree stops re-rendering on unrelated store
  // ticks. selectNode/selectEdge/setActiveTab are stable Zustand actions.
  const handleNodeClick = useCallback((_: React.MouseEvent, node: WorkflowGraphNode) => {
    selectNode(node.id)
    setActiveTab('inspector')
  }, [selectNode, setActiveTab])
  const handleEdgeClick = useCallback((_: React.MouseEvent, edge: WorkflowGraphEdge) => {
    selectEdge(edge.id)
    setActiveTab('inspector')
  }, [selectEdge, setActiveTab])
  const addWorkflowNode = useCallback((type: string, position?: { x: number; y: number }) => {
    addNode(type, position)
    setActiveTab('inspector')
  }, [addNode, setActiveTab])

  const focusSidebarSearch = useCallback(() => {
    // Focus the sidebar search input via a stable data attribute so a
    // future CSS class rename doesn't silently no-op the shortcut.
    const search = document.querySelector<HTMLInputElement>('[data-shortcut="sidebar-search"]')
    if (search) {
      search.focus()
      search.select()
      return true
    }
    return false
  }, [])

  const openAiAuthoringAction = useCallback((action: AiAuthoringAction, prompt?: string): void => {
    setAiActionRequest((current) => ({
      id: (current?.id ?? 0) + 1,
      action,
      ...(prompt ? { prompt } : {}),
    }))
    setActiveTab('ai-studio')
  }, [setActiveTab])

  // Warn on tab close / reload while the canvas holds unsaved edits. The
  // browser shows its own generic dialog; we only flag the condition.
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!useWorkflowStore.getState().workflowDirty) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [])

  // Debounced localStorage autosave of unsaved canvas edits (drafts).
  useDraftAutosave()

  useIdentityBootstrap({
    authReady,
    userId,
    orgId,
    setAuth,
    clearAuth,
    setAuthReady,
    setIdentityContext,
    setIdentityPending,
    addToast,
    t,
  })

  // Live-run SSE stream (primary). Owns `streamTransport`; on first byte it
  // sets `streamStatus='connected'` and the poll loop below skips its tick. On
  // any stream fault it sets `'polling'` and the very next tick resumes.
  useRunEventStream(runId, projectRunSummary)

  // Terminal-run callback for the poll loop: bump platform version so
  // independent panels re-fetch (cross-panel reactivity), then refetch the
  // shell's platform data. Stable so the poll effect doesn't re-bind per render.
  const onRunTerminal = useCallback(() => {
    bumpPlatformVersion()
    return refreshPlatform()
  }, [bumpPlatformVersion, refreshPlatform])

  // Polling fallback (1.5s `/status`). Loads the initial timeline + stays as the
  // safety net behind SSE. `loadStatus` is reused by the run-action handlers.
  const { loadStatus } = useRunPolling(runId, onRunTerminal, beginRunProjectionUpdate)
  const runPlatformMutation = usePlatformMutation()

  const selectedNode = useMemo(() => nodes.find(node => node.id === selectedNodeId) ?? null, [nodes, selectedNodeId])
  const selectedEdge = useMemo(() => edges.find(edge => edge.id === selectedEdgeId) ?? null, [edges, selectedEdgeId])

  const nodeStatusMap = useMemo(() => {
    return new Map(runNodes.map(node => [node.nodeId, node.status]))
  }, [runNodes])

  // `/runs` intentionally omits the heavy input snapshot. `runDetail` is
  // render-tracked in the store, while this guard rejects every stale open or
  // start response after the operator selects a different run/auth context.
  // An auth-owner transition also clears the complete active-run projection so
  // no prior tenant's nodes or timeline survive while bootstrap data refreshes.
  const runTransitionGuard = useMemo(() => createRunTransitionGuard(
    () => useWorkflowStore.getState().runTransitionGeneration,
  ), [])

  // Pure projections delegated to `./canvas-projections`. The memos
  // depend ONLY on structural inputs — locale-dependent rendering
  // (node label / helper, conditional-edge label) lives inside the
  // leaf components `WorkflowStepNode` and `WorkflowEdge`, both
  // subscribed to language changes via `useT()`. Result: a locale
  // toggle re-renders the leaf components without re-projecting the
  // full graph; a `platformVersion` bump that doesn't actually change
  // the edge list lets React Flow skip downstream work via identity
  // comparison.
  const visibleNodes = useMemo<WorkflowGraphNode[]>(
    () => projectVisibleNodes(nodes, nodeStatusMap, validationIssues, selectedNodeId),
    [nodes, nodeStatusMap, selectedNodeId, validationIssues],
  )
  const visibleEdges = useMemo<WorkflowGraphEdge[]>(
    () => projectVisibleEdges(edges, selectedEdgeId),
    [edges, selectedEdgeId],
  )

  const {
    applyWorkflowImprovement,
    applyWorkflowProposal,
    approveNode,
    beginWorkflowCreation,
    cancelActiveRun,
    clearActiveRun,
    confirmReplaceCanvas,
    createCredential,
    createNewWorkflow,
    compileWorkflowBrief,
    explainWorkflow,
    fireSignOut,
    injectPackFailure,
    installPack,
    installPlugin,
    loadOlderEvents,
    loadAuthoringCapabilities,
    maybeRestoreDraft,
    openHomeTab,
    openRecoveryQueue,
    openRun,
    openWorkflow,
    openWorkflowVersion,
    proposeWorkflow,
    redriveNode,
    replayDeadLetter,
    replayNode,
    resolveDeadLetter,
    reviewWorkflow,
    sampleRunPack,
    saveWorkflow,
    startWorkflow,
    submitHumanForm,
    submitRunInput,
    suggestWorkflowImprovement,
    updateEdgeCondition,
    updateEdgeOnError,
    useTemplate,
    validateWorkflow,
  } = useAppCommands({
    store: appStore,
    permissions: tenantPermissions,
    projectedRuns,
    refreshPlatform,
    projectRunSummary,
    loadStatus,
    runTransitionGuard,
    runPlatformMutation,
    setValidationIssues,
    setAiReviewIssues,
    setRunInputOpen,
    setRunInputServerErrors,
    setRunInputSubmitting,
    setActivityRecoveryId,
    setPaletteOpen,
    setShortcutsOpen,
    focusSidebarSearch,
    t,
  })

  // Hold the normalized alert target across auth and tenant bootstrap. App's
  // org transition intentionally clears selected operational state, so
  // consuming and opening the URL inside an earlier command-hook effect can
  // lose the incident on cold load. Open exactly once only after the final
  // tenant and its permissions are known.
  useEffect(() => {
    const deadLetterId = initialRecoveryDeepLink?.deadLetterId
    if (
      recoveryDeepLinkOpened.current
      || !tenantReady
      || !deadLetterId
      || !tenantPermissions.includes('runs.read')
      || !tenantPermissions.includes('dlq.read')
    ) return
    recoveryDeepLinkOpened.current = true
    openRecoveryQueue(deadLetterId)
  }, [initialRecoveryDeepLink, openRecoveryQueue, tenantPermissions, tenantReady])

  const draftRecoveryOffered = useRef(false)
  useEffect(() => {
    if (!tenantReady || draftRecoveryOffered.current) return
    draftRecoveryOffered.current = true
    const latest = readLatestDraft()
    if (latest) void maybeRestoreDraft(latest.workflowId)
  }, [tenantReady, maybeRestoreDraft])

  // Shell derivations are memoized on their inputs: the shell renders on
  // every store tick, and these walks over runs, nodes and dead letters used
  // to run on each of them.
  const openDlqCount = useMemo(() => deadLetters.filter(dlq => dlq.status === 'open').length, [deadLetters])
  // Waiting is a run-level posture. Semantic quarantine deliberately leaves
  // its source node succeeded, so node-only counting would report all-clear
  // while downstream effects remain contained.
  const blockerCount = useMemo(
    () => countActiveRecoveryBlockers(projectedRuns, runNodes, runId, semanticBlockerRunIds),
    [projectedRuns, runNodes, runId, semanticBlockerRunIds],
  )
  const activeRunCount = useMemo(() => projectedRuns.filter(run => isOpenRunStatus(run.status)).length, [projectedRuns])
  const observedRun = useMemo(
    () => runId ? (runDetail?.id === runId ? runDetail : projectedRuns.find(run => run.id === runId)) : undefined,
    [runId, runDetail, projectedRuns],
  )
  const paletteWorkflows = useMemo(() => savedWorkflows.map(workflow => ({ id: workflow.id, name: workflow.name })), [savedWorkflows])
  const paletteRecipes = useMemo(() => templates.map(template => ({ id: template.id, name: template.name })), [templates])

  if (!authReady || (userId !== null && !identityReady)) return (
    <div className="boot-screen" role="status" aria-live="polite">
      <div className="boot-screen__inner">
        <BrandMark size={64} />
        <span className="boot-screen__label">{t('app.loading')}</span>
      </div>
    </div>
  )
  if (!userId && isSupabaseConfigured) return <Login onAuthenticated={() => undefined} />
  if (identityContext && !identityContext.currentOrganizationId) {
    return <WorkspaceGate context={identityContext} />
  }

  const env: 'sandbox' | 'production' = (import.meta as { env?: { PROD?: boolean } }).env?.PROD ? 'production' : 'sandbox'
  const currentOrganizationLabel = currentOrganization?.name ?? orgId ?? 'default'
  const recoverState: 'blocked' | 'attention' | 'clear' =
    blockerCount > 0 ? 'blocked' : openDlqCount > 0 ? 'attention' : 'clear'

  return (
    <AppWorkspace
      activeTab={activeTab}
      permissions={tenantPermissions}
      header={{
        environment: env,
        organizationLabel: currentOrganizationLabel,
        workflowName: currentWorkflowName,
        workflowSaved: currentWorkflowSaved,
        workflowId: currentWorkflowId,
        workflowVersion: currentWorkflowVersion?.version ?? null,
        workflowRunsCount: runs.length,
        aiHealth,
        streamStatus,
        recoveryPosture: recoverState,
        recoveryBlockerCount: blockerCount,
        openRecoveryCount: openDlqCount,
        activeRunCount,
      }}
      rightPanel={{
        authoring: {
          aiHealth,
          runNodes,
          selectedNode,
          selectedEdge,
          workflowNodes: nodes,
          workflowEdges: edges,
          validationIssues,
          readinessResult,
          aiReviewIssues,
          tools,
          workflows: savedWorkflows,
          currentWorkflowId,
          currentWorkflowName,
          currentWorkflowInputs,
          currentWorkflowOutputs,
          onUpdateNodeConfig: updateSelectedNodeConfig,
          onUpdateNodeType: updateSelectedNodeType,
          onUpdateEdgeCondition: updateEdgeCondition,
          onUpdateEdgeOnError: updateEdgeOnError,
          onValidateWorkflow: validateWorkflow,
          onInsertSnippet: () => setSnippetMenuOpen(true),
          onLoadAuthoringCapabilities: loadAuthoringCapabilities,
          onCompileWorkflowBrief: compileWorkflowBrief,
          onProposeWorkflow: proposeWorkflow,
          onApplyWorkflowProposal: applyWorkflowProposal,
          onExplainWorkflow: explainWorkflow,
          onReviewWorkflow: reviewWorkflow,
          aiActionRequest,
          onSuggestWorkflowImprovement: suggestWorkflowImprovement,
          onApplyWorkflowImprovement: applyWorkflowImprovement,
        },
        catalog: {
          tools,
          templates,
          solutionPacks,
          credentials,
          workflows: savedWorkflows,
          onOpenWorkflow: openWorkflow,
          onOpenWorkflowVersion: openWorkflowVersion,
          onCreateWorkflow: beginWorkflowCreation,
          onUseTemplate: useTemplate,
          onInstallPlugin: installPlugin,
          onInstallPack: installPack,
          onSampleRunPack: sampleRunPack,
          onInjectPackFailure: injectPackFailure,
          onCreateCredential: createCredential,
        },
        execution: {
          events,
          eventsHasMore,
          onLoadOlderEvents: loadOlderEvents,
          runNodes,
          runs: projectedRuns,
          deadLetters,
          workflows: savedWorkflows,
          activeRunId: runId,
          activeRecoveryId: activityRecoveryId,
          usage,
          onOpenRun: openRun,
          onRefreshPlatform: refreshPlatform,
          onApproveNode: approveNode,
          onSubmitHumanForm: submitHumanForm,
          onReplayNode: replayNode,
          onRedriveNode: redriveNode,
          onCancelActiveRun: cancelActiveRun,
          onSelectRecovery: setActivityRecoveryId,
          onClearActiveRun: clearActiveRun,
          onReplayDeadLetter: replayDeadLetter,
          onResolveDeadLetter: resolveDeadLetter,
        },
        navigation: {
          onOpenTab: setActiveTab,
          onOpenAiAction: openAiAuthoringAction,
          activeRecoveryCaseId,
        },
      }}
      canvas={{
        activated: canvasActivated,
        nodes: visibleNodes,
        edges: visibleEdges,
        onNodesChange,
        onEdgesChange,
        onConnect: connect,
        onNodeClick: handleNodeClick,
        onEdgeClick: handleEdgeClick,
        onAddNode: addWorkflowNode,
        readOnly: !canWriteWorkflows,
        workflowId: currentWorkflowId ?? 'workflow-canvas',
        viewportWorkflowId: currentWorkflowSaved ? (currentWorkflowId ?? undefined) : undefined,
      }}
      home={{
        runs: projectedRuns,
        runNodes,
        deadLetters,
        onSemanticBlockerRunsChange: setSemanticBlockerRunIds,
        onOpenTab: openHomeTab,
        onOpenRecoveryCase: openRecoveryCase,
        onOpenRun: openRun,
        onOpenRecoveryQueue: openRecoveryQueue,
        onStartRecoveryDrill: canInstallPacks
          ? () => injectPackFailure('failed-payment-recovery', 'billing_secret_unbound')
          : undefined,
      }}
      observedRun={observedRun}
      runNodes={runNodes}
      runInput={runInputOpen && currentWorkflowInputs ? {
        inputs: currentWorkflowInputs,
        workflowName: currentWorkflowName,
        serverErrors: runInputServerErrors,
        submitting: runInputSubmitting,
        onSubmit: submitRunInput,
        onCancel: () => setRunInputOpen(false),
        ...(runInputPresets !== undefined ? {
          presets: runInputPresets,
          onSavePreset: saveRunInputPreset,
          onDeletePreset: deleteRunInputPreset,
        } : {}),
      } : null}
      palette={{
        visible: paletteOpen,
        open: paletteOpen,
        onClose: closePalette,
        openTab: setActiveTab,
        onValidate: validateWorkflow,
        onSave: saveWorkflow,
        onStart: startWorkflow,
        onNew: () => { void createNewWorkflow() },
        onSignOut: fireSignOut,
        docsUrl: DOCS_URL,
        onInsertSnippet: () => setSnippetMenuOpen(true),
        permissions: tenantPermissions,
        workflows: paletteWorkflows,
        recipes: paletteRecipes,
        onOpenWorkflow: (id) => { void openWorkflow(id) },
        onOpenRecipe: (id) => {
          const template = templates.find(candidate => candidate.id === id)
          if (!template) return
          void (async () => {
            if (!await confirmReplaceCanvas()) return
            hydrateWorkflow(template.workflow, { saved: false, dirty: true })
            setValidationIssues([])
            setActiveTab('inspector')
          })()
        },
      }}
      shortcutsOpen={shortcutsOpen}
      snippetMenuOpen={snippetMenuOpen}
      onWorkflowNameChange={setWorkflowName}
      onValidate={validateWorkflow}
      onSave={saveWorkflow}
      onStart={startWorkflow}
      onOpenTab={setActiveTab}
      onOpenHelp={openShortcuts}
      onOpenRecovery={openRecoveryQueue}
      onReadinessResult={handleReadinessResult}
      onOpenPalette={() => setPaletteOpen(true)}
      onCloseShortcuts={closeShortcuts}
      onCloseSnippetMenu={closeSnippetMenu}
    />
  )
}
