/**
 * Local draft substrate for the canvas (S-01, draft-safe authoring). The
 * versioned save (`POST /workflows/save`) stays validity-gated on BOTH sides —
 * a semantically-invalid "latest version" would poison rollback counting,
 * schedule sync, and readiness. Drafts therefore live CLIENT-SIDE: a debounced
 * localStorage autosave of the canvas whenever it holds unsaved edits, plus a
 * restore path so a crash / accidental close / invalid-blocked save never
 * loses an author's work.
 *
 * Keying: `janusly:draft:<org>:<workflowId>` — org-scoped so two tenants in
 * one browser don't see each other's drafts. A `janusly:draft:latest:<org>`
 * pointer tracks the most recent draft so App can offer crash-recovery on
 * mount even for a never-saved workflow (whose random id is otherwise
 * unreachable — it isn't in the Flows list yet).
 *
 * Used by:
 * - `apps/web/src/App.tsx` (mounts `useDraftAutosave`; reads/clears drafts on
 *   open + mount for the restore prompt).
 */

import { useEffect } from 'react'
import { getActiveOrg } from '../auth'
import { useWorkflowStore } from '../store'
import { getRunWorkflowSnapshot } from '../canvas-projections'
import type { WorkflowDefinition } from '../types'

/** One persisted draft: the serialized canvas + when it was captured. */
export type CanvasDraft = {
  workflow: WorkflowDefinition
  savedAt: string
}

/** Debounce for the autosave write — long enough to coalesce a typing burst. */
const DRAFT_WRITE_DEBOUNCE_MS = 1_000

/** Skip absurdly large drafts instead of hitting the localStorage quota. */
const DRAFT_MAX_BYTES = 512 * 1024

function draftKey(workflowId: string): string {
  return `janusly:draft:${getActiveOrg()}:${workflowId}`
}

function latestPointerKey(): string {
  return `janusly:draft:latest:${getActiveOrg()}`
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    return null // storage disabled (private mode / iframe policy)
  }
}

/** Read the draft persisted for `workflowId`, or null. */
export function readDraft(workflowId: string): CanvasDraft | null {
  const storage = safeStorage()
  if (!storage) return null
  try {
    const raw = storage.getItem(draftKey(workflowId))
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const draft = parsed as { workflow?: unknown; savedAt?: unknown }
    if (!draft.workflow || typeof draft.savedAt !== 'string') return null
    const workflow = getRunWorkflowSnapshot({ workflow: draft.workflow })
    if (!workflow) return null
    return { workflow, savedAt: draft.savedAt }
  } catch {
    return null
  }
}

/**
 * Read the most recent draft in this org regardless of workflow id — the
 * crash-recovery entry point for never-saved workflows. Returns the draft plus
 * its workflow id, or null.
 */
export function readLatestDraft(): (CanvasDraft & { workflowId: string }) | null {
  const storage = safeStorage()
  if (!storage) return null
  try {
    const workflowId = storage.getItem(latestPointerKey())
    if (!workflowId) return null
    const draft = readDraft(workflowId)
    return draft ? { ...draft, workflowId } : null
  } catch {
    return null
  }
}

/** Remove the draft for `workflowId` (and the latest-pointer if it targets it). */
export function clearDraft(workflowId: string): void {
  const storage = safeStorage()
  if (!storage) return
  try {
    storage.removeItem(draftKey(workflowId))
    if (storage.getItem(latestPointerKey()) === workflowId) {
      storage.removeItem(latestPointerKey())
    }
  } catch {
    // Best-effort — a failed clear only means a stale restore offer later.
  }
}

function writeDraft(workflowId: string, workflow: WorkflowDefinition): void {
  const storage = safeStorage()
  if (!storage) return
  try {
    const payload = JSON.stringify({ workflow, savedAt: new Date().toISOString() } satisfies CanvasDraft)
    if (payload.length > DRAFT_MAX_BYTES) return
    storage.setItem(draftKey(workflowId), payload)
    storage.setItem(latestPointerKey(), workflowId)
  } catch {
    // Quota / disabled storage — losing the autosave must never break editing.
  }
}

/**
 * Mount-once hook: debounce-writes the canvas to localStorage while it holds
 * unsaved edits, and clears the draft when those edits are persisted
 * server-side (the dirty→clean transition on the SAME workflow id — a
 * hydrate/new that lands on a different id must not clear the outgoing
 * workflow's draft, that's the crash-recovery copy).
 */
export function useDraftAutosave(): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let prevDirty = useWorkflowStore.getState().workflowDirty
    let prevWorkflowId = useWorkflowStore.getState().currentWorkflowId

    const unsubscribe = useWorkflowStore.subscribe((state) => {
      const { workflowDirty, currentWorkflowId } = state
      if (workflowDirty) {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          const current = useWorkflowStore.getState()
          if (!current.workflowDirty) return // saved while the debounce was pending
          writeDraft(current.currentWorkflowId, current.getWorkflowJson())
        }, DRAFT_WRITE_DEBOUNCE_MS)
      } else if (prevDirty && currentWorkflowId === prevWorkflowId) {
        // dirty → clean on the same workflow = a successful versioned save.
        if (timer) { clearTimeout(timer); timer = null }
        clearDraft(currentWorkflowId)
      } else if (timer && currentWorkflowId !== prevWorkflowId) {
        // Canvas replaced mid-debounce — don't write the OLD content under the
        // NEW id. The outgoing draft (if any) was already flushed or persists
        // from its last completed write.
        clearTimeout(timer)
        timer = null
      }
      prevDirty = workflowDirty
      prevWorkflowId = currentWorkflowId
    })

    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [])
}
