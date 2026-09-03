import { describe, expect, it, vi } from 'vitest'
import { createRunTransitionGuard, isRunRequestCurrent } from './run-transition'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

describe('createRunTransitionGuard', () => {
  it('rejects a deferred open after a newer run transition begins', async () => {
    const guard = createRunTransitionGuard()
    const firstResponse = deferred<string>()
    const commit = vi.fn()
    const firstRequest = guard.begin()
    const pendingCommit = firstResponse.promise.then(value => {
      if (guard.isCurrent(firstRequest)) commit(value)
    })

    const secondRequest = guard.begin()
    firstResponse.resolve('run-a')
    await pendingCommit

    expect(commit).not.toHaveBeenCalled()
    expect(guard.isCurrent(secondRequest)).toBe(true)
  })

  it('invalidates a pending response when the atomic owner generation changes', () => {
    let generation = 0
    const guard = createRunTransitionGuard(() => generation)
    const request = guard.begin()
    generation += 1
    expect(guard.isCurrent(request)).toBe(false)
  })

  it('owns paginated responses by both run id and transition generation', () => {
    const request = { runId: 'run-a', generation: 4 }
    expect(isRunRequestCurrent(request, { runId: 'run-a', runTransitionGeneration: 4 })).toBe(true)
    expect(isRunRequestCurrent(request, { runId: 'run-b', runTransitionGeneration: 4 })).toBe(false)
    expect(isRunRequestCurrent(request, { runId: 'run-a', runTransitionGeneration: 5 })).toBe(false)
  })
})
