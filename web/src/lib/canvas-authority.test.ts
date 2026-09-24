import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useWorkflowStore } from '../store'
import { currentCanvasAuthority, canvasAuthorityMatches, ownCanvas } from './canvas-authority'

const initial = useWorkflowStore.getState()
beforeEach(() => useWorkflowStore.setState(initial, true))

describe('canvas operation authority', () => {
  it.each(['orgId', 'userId', 'currentWorkflowId'] as const)('invalidates when %s changes', field => {
    const owner = currentCanvasAuthority()
    useWorkflowStore.setState({ [field]: 'other' })
    expect(canvasAuthorityMatches(owner)).toBe(false)
  })
  it('tracks semantic edits but not toast or loading changes', () => {
    const owner = currentCanvasAuthority()
    useWorkflowStore.getState().addToast('Unrelated', 'info')
    expect(canvasAuthorityMatches(owner)).toBe(true)
    useWorkflowStore.getState().setWorkflowName('Edited')
    expect(canvasAuthorityMatches(owner)).toBe(false)
  })
  it('aborts once on a context change and unsubscribes even if context returns', () => {
    const invalidated = vi.fn()
    const lease = ownCanvas(invalidated)
    const original = useWorkflowStore.getState().userId
    useWorkflowStore.setState({ userId: 'other' })
    useWorkflowStore.setState({ userId: original })
    expect(lease.signal.aborted).toBe(true)
    expect(invalidated).toHaveBeenCalledTimes(1)
  })
  it('disposes an unused lease without treating disposal as context invalidation', () => {
    const invalidated = vi.fn()
    const lease = ownCanvas(invalidated)
    lease.abort()
    useWorkflowStore.setState({ orgId: 'elsewhere' })
    expect(invalidated).not.toHaveBeenCalled()
  })

})
