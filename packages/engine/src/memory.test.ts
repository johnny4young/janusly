import { describe, expect, it } from 'vitest'
import { summarizeMemory, type MemoryEntry } from './memory'

describe('summarizeMemory', () => {
  it('preserves order and adds an index', () => {
    const memory: MemoryEntry[] = [
      { type: 'node.succeeded', nodeId: 'a', payload: { ok: true } },
      { type: 'node.failed', nodeId: 'b', payload: { error: 'boom' } },
    ]

    const summary = summarizeMemory(memory)
    expect(summary).toEqual([
      { index: 0, type: 'node.succeeded', nodeId: 'a', payload: { ok: true } },
      { index: 1, type: 'node.failed', nodeId: 'b', payload: { error: 'boom' } },
    ])
  })

  it('supports an empty list', () => {
    expect(summarizeMemory([])).toEqual([])
  })
})
