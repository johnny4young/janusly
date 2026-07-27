/**
 * Server-data bootstrap for the Janusly Studio shell. Owns the nine pieces of
 * platform state the shell renders (tools, templates, solution packs,
 * credentials, runs, saved workflows, dead letters, usage, AI health), the
 * `refreshPlatform` fan-out that re-fetches all of them in one `Promise.allSettled`
 * pass, and the effect that fires that fan-out once auth is ready. Extracted from
 * `App` so the shell component is not carrying nine `useState`s plus the bulk
 * fetcher inline.
 *
 * Used by:
 * - `apps/web/src/App.tsx`
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AiHealth, Credential, RunSummary, SavedWorkflow, SolutionPackPublic, Template, ToolSchema } from '../types'

/** The bootstrap state surface plus the manual re-fetch trigger. */
export type BootstrapData = {
  tools: ToolSchema[]
  templates: Template[]
  solutionPacks: SolutionPackPublic[]
  credentials: Credential[]
  runs: RunSummary[]
  savedWorkflows: SavedWorkflow[]
  deadLetters: DeadLetter[]
  usage: Record<string, number>
  aiHealth: AiHealth | null
  refreshPlatform: () => Promise<void>
  /** Merge live/detail fields into one run without discarding detail-only data such as inputJson. */
  patchRunSummary: (runId: string, patch: Partial<RunSummary>) => void
  /** Reserve ownership before an async summary read so a newer live update can invalidate its response. */
  beginRunSummaryUpdate: RunSummaryUpdateStarter
}

export type RunSummaryUpdateCommitter = (patch: Partial<RunSummary>) => boolean
export type RunSummaryUpdateStarter = (runId: string) => RunSummaryUpdateCommitter

// `DeadLetter` is declared next to the panel that owns its row shape; re-import
// it here so the hook's return type matches what `App` passed down before the
// extraction.
import type { DeadLetter } from '../components/DeadLettersPanel'

export function patchRunSummaryList(
  current: RunSummary[],
  runId: string,
  patch: Partial<RunSummary>,
): RunSummary[] {
  const index = current.findIndex(run => run.id === runId)
  if (index === -1) {
    if (typeof patch.status !== 'string') return current
    return [{ ...patch, id: runId, status: patch.status }, ...current]
  }
  return current.map((run, runIndex) => runIndex === index ? { ...run, ...patch, id: runId } : run)
}

export function mergeRunSummaryPage(current: RunSummary[], incoming: RunSummary[]): RunSummary[] {
  const currentById = new Map(current.map(run => [run.id, run]))
  return incoming.map(run => ({ ...currentById.get(run.id), ...run }))
}

export function mergeRunSummaryPageWithPatches(
  current: RunSummary[],
  incoming: RunSummary[],
  patches: ReadonlyArray<{ runId: string; patch: Partial<RunSummary> }>,
): RunSummary[] {
  let merged = mergeRunSummaryPage(current, incoming)
  for (const { runId, patch } of patches) {
    merged = patchRunSummaryList(merged, runId, patch)
  }
  return merged
}

export type RunSummaryUpdateCoordinator = {
  reserve: (runId: string) => number
  isCurrent: (runId: string, revision: number) => boolean
  reset: () => void
}

/** Coordinates async snapshots with immediate SSE/list patches per run. */
export function createRunSummaryUpdateCoordinator(): RunSummaryUpdateCoordinator {
  let sequence = 0
  const revisions = new Map<string, number>()
  return {
    reserve(runId) {
      sequence += 1
      revisions.set(runId, sequence)
      return sequence
    },
    isCurrent(runId, revision) {
      return revisions.get(runId) === revision
    },
    reset() {
      sequence = 0
      revisions.clear()
    },
  }
}

/**
 * Fetches and holds the shell's platform data. `refreshPlatform` re-runs the
 * whole fan-out (every setter guarded by `status === 'fulfilled'`, so a single
 * failing endpoint never blanks the rest of the dashboard) and is also fired
 * automatically the first time `authReady` flips true.
 */
export function useBootstrapData(
  tenantScope: string | null,
  permissions: readonly string[] = [],
): BootstrapData {
  const [tools, setTools] = useState<ToolSchema[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [solutionPacks, setSolutionPacks] = useState<SolutionPackPublic[]>([])
  const [credentials, setCredentials] = useState<Credential[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflow[]>([])
  const [deadLetters, setDeadLetters] = useState<DeadLetter[]>([])
  const [usage, setUsage] = useState<Record<string, number>>({})
  const [aiHealth, setAiHealth] = useState<AiHealth | null>(null)
  const tenantScopeRef = useRef<string | null>(tenantScope)
  const permissionsRef = useRef<ReadonlySet<string>>(new Set(permissions))
  const refreshSequenceRef = useRef(0)
  const runPatchSequenceRef = useRef(0)
  const runPatchesRef = useRef(new Map<string, {
    revision: number
    patch: Partial<RunSummary>
  }>())
  const runUpdateCoordinatorRef = useRef(createRunSummaryUpdateCoordinator())
  const permissionKey = permissions.join('\u0000')

  const patchRunSummary = useCallback((runId: string, patch: Partial<RunSummary>) => {
    runUpdateCoordinatorRef.current.reserve(runId)
    const revision = runPatchSequenceRef.current + 1
    runPatchSequenceRef.current = revision
    const previous = runPatchesRef.current.get(runId)
    runPatchesRef.current.set(runId, {
      revision,
      patch: { ...previous?.patch, ...patch },
    })
    setRuns(current => patchRunSummaryList(current, runId, patch))
  }, [])

  const beginRunSummaryUpdate = useCallback<RunSummaryUpdateStarter>((runId) => {
    const revision = runUpdateCoordinatorRef.current.reserve(runId)
    return (patch) => {
      if (!runUpdateCoordinatorRef.current.isCurrent(runId, revision)) return false
      patchRunSummary(runId, patch)
      return true
    }
  }, [patchRunSummary])

  const refreshPlatform = useCallback(async () => {
    const requestedScope = tenantScopeRef.current
    if (!requestedScope) return
    const requestSequence = refreshSequenceRef.current + 1
    refreshSequenceRef.current = requestSequence
    const runPatchFloor = runPatchSequenceRef.current
    const allowed = permissionsRef.current
    const read = (permission: string, path: string, fallback: unknown) => allowed.has(permission)
      ? api(path)
      : Promise.resolve(fallback)
    const [toolData, templateData, packData, credentialData, runData, deadLetterData, usageData, aiHealthData, workflowsData] = await Promise.allSettled([
      read('workflows.read', '/tools', []),
      read('workflows.read', '/templates', []),
      read('packs.read', '/solution-packs', { packs: [] }),
      read('credentials.read', '/credentials', []),
      read('runs.read', '/runs', []),
      read('dlq.read', '/dlq', []),
      api('/billing/usage'),
      api('/ai/health'),
      read('workflows.read', '/workflows', []),
    ])

    // A workspace switch may happen while the fan-out is in flight. Never
    // project the previous tenant's late response into the newly selected UI.
    if (
      tenantScopeRef.current !== requestedScope
      || refreshSequenceRef.current !== requestSequence
    ) return

    if (toolData.status === 'fulfilled') setTools(Array.isArray(toolData.value) ? toolData.value : [])
    if (templateData.status === 'fulfilled') setTemplates(Array.isArray(templateData.value) ? templateData.value : [])
    if (packData.status === 'fulfilled') {
      const packs = (packData.value as { packs?: SolutionPackPublic[] } | null)?.packs
      setSolutionPacks(Array.isArray(packs) ? packs : [])
    }
    if (credentialData.status === 'fulfilled') setCredentials(Array.isArray(credentialData.value) ? credentialData.value : [])
    if (runData.status === 'fulfilled') {
      const incoming = Array.isArray(runData.value) ? runData.value as RunSummary[] : []
      const newerPatches = [...runPatchesRef.current]
        .filter(([, entry]) => entry.revision > runPatchFloor)
        .map(([runId, entry]) => ({ runId, patch: entry.patch }))
      // The list intentionally omits the heavy inputJson field. Preserve detail
      // already loaded for a selected run. Live/SSE patches that landed after
      // this fan-out began also remain authoritative over its older snapshot.
      setRuns(current => mergeRunSummaryPageWithPatches(current, incoming, newerPatches))
      for (const [runId, entry] of runPatchesRef.current) {
        if (entry.revision <= runPatchFloor) runPatchesRef.current.delete(runId)
      }
    }
    if (deadLetterData.status === 'fulfilled') setDeadLetters(Array.isArray(deadLetterData.value) ? deadLetterData.value : [])
    if (usageData.status === 'fulfilled' && usageData.value && typeof usageData.value === 'object') {
      setUsage(usageData.value as Record<string, number>)
    }
    if (aiHealthData.status === 'fulfilled' && aiHealthData.value && typeof aiHealthData.value === 'object') {
      setAiHealth(aiHealthData.value as AiHealth)
    }
    if (workflowsData.status === 'fulfilled') setSavedWorkflows(Array.isArray(workflowsData.value) ? workflowsData.value : [])
  }, [])

  useEffect(() => {
    refreshSequenceRef.current += 1
    runPatchSequenceRef.current = 0
    runPatchesRef.current.clear()
    runUpdateCoordinatorRef.current.reset()
    tenantScopeRef.current = tenantScope
    permissionsRef.current = new Set(permissionKey ? permissionKey.split('\u0000') : [])
    setTools([])
    setTemplates([])
    setSolutionPacks([])
    setCredentials([])
    setRuns([])
    setSavedWorkflows([])
    setDeadLetters([])
    setUsage({})
    setAiHealth(null)
    if (tenantScope) void refreshPlatform()
  }, [tenantScope, permissionKey, refreshPlatform])

  return {
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
  }
}
