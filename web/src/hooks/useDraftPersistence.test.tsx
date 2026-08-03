/**
 * Tests for the local draft substrate: the debounced localStorage
 * autosave of unsaved canvas edits, the dirty→clean clear-on-save, and the
 * crash-recovery latest-pointer.
 */

import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readDraft, readLatestDraft, clearDraft, useDraftAutosave } from './useDraftPersistence'
import { useWorkflowStore } from '../store'

const initialState = useWorkflowStore.getState()

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
  useWorkflowStore.setState(
    {
      ...initialState,
      currentWorkflowId: 'wf_draft_test',
      currentWorkflowName: 'Draft test',
      workflowDirty: false,
      nodes: [],
      edges: [],
    },
    true,
  )
})

afterEach(() => {
  vi.useRealTimers()
  window.localStorage.clear()
})

describe('useDraftAutosave (local drafts)', () => {
  it('debounce-writes a draft when the canvas turns dirty', () => {
    renderHook(() => useDraftAutosave())

    useWorkflowStore.getState().addNode('http')
    expect(readDraft('wf_draft_test')).toBeNull() // debounce pending

    vi.advanceTimersByTime(1_100)
    const draft = readDraft('wf_draft_test')
    expect(draft).not.toBeNull()
    expect(draft?.workflow.nodes).toHaveLength(1)
    expect(typeof draft?.savedAt).toBe('string')
  })

  it('clears the draft on the dirty→clean transition of the SAME workflow (a save)', () => {
    renderHook(() => useDraftAutosave())

    useWorkflowStore.getState().addNode('http')
    vi.advanceTimersByTime(1_100)
    expect(readDraft('wf_draft_test')).not.toBeNull()

    useWorkflowStore.getState().markWorkflowSaved()
    expect(readDraft('wf_draft_test')).toBeNull()
  })

  it('hydrating a DIFFERENT workflow keeps the outgoing draft (crash-recovery copy)', () => {
    renderHook(() => useDraftAutosave())

    useWorkflowStore.getState().addNode('http')
    vi.advanceTimersByTime(1_100)
    expect(readDraft('wf_draft_test')).not.toBeNull()

    useWorkflowStore.getState().hydrateWorkflow({ id: 'wf_other', name: 'Other', nodes: [], edges: [] })
    // dirty went false but on a different id — the draft must survive.
    expect(readDraft('wf_draft_test')).not.toBeNull()
  })

  it('a canvas replacement mid-debounce never writes the OLD content under the NEW id', () => {
    renderHook(() => useDraftAutosave())

    useWorkflowStore.getState().addNode('http')
    // Replace before the debounce fires.
    useWorkflowStore.getState().hydrateWorkflow({ id: 'wf_other', name: 'Other', nodes: [], edges: [] })
    vi.advanceTimersByTime(2_000)

    expect(readDraft('wf_other')).toBeNull()
    expect(readDraft('wf_draft_test')).toBeNull() // never completed a write
  })

  it('readLatestDraft returns the most recent draft and clearDraft drops the pointer', () => {
    renderHook(() => useDraftAutosave())

    useWorkflowStore.getState().addNode('http')
    vi.advanceTimersByTime(1_100)

    const latest = readLatestDraft()
    expect(latest?.workflowId).toBe('wf_draft_test')

    clearDraft('wf_draft_test')
    expect(readLatestDraft()).toBeNull()
  })

  it('rejects corrupt historical drafts instead of crashing canvas hydration', () => {
    const key = 'janusly:draft:default:wf_corrupt'
    const write = (workflow: unknown) => localStorage.setItem(key, JSON.stringify({ workflow, savedAt: new Date().toISOString() }))

    write({ nodes: 'truncated', edges: [] })
    expect(readDraft('wf_corrupt')).toBeNull()

    write({ nodes: [{ id: 'a', type: 'noop', config: {} }], edges: [{ from: 'a', to: 'missing' }] })
    expect(readDraft('wf_corrupt')).toBeNull()

    write({
      nodes: [
        { id: 'duplicate', type: 'noop', config: {} },
        { id: 'duplicate', type: 'http', config: {} },
      ],
      edges: [],
    })
    expect(readDraft('wf_corrupt')).toBeNull()

    write({ id: '', nodes: [{ id: 'a', type: 'noop', config: {} }], edges: [] })
    expect(readDraft('wf_corrupt')).toBeNull()

    write({
      id: 'wf_corrupt',
      inputs: { type: 'object', properties: { invoiceId: null } },
      nodes: [{ id: 'a', type: 'noop', config: {} }],
      edges: [],
    })
    expect(readDraft('wf_corrupt')).toBeNull()

    write({
      id: 'wf_corrupt',
      outputs: { result: null },
      nodes: [{ id: 'a', type: 'noop', config: {} }],
      edges: [],
    })
    expect(readDraft('wf_corrupt')).toBeNull()
  })
})
