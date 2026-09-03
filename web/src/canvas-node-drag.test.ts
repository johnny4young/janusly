import { describe, expect, it, vi } from 'vitest'

import {
  hasNodePaletteDrag,
  NODE_PALETTE_DRAG_TYPE,
  readNodePaletteDrag,
  writeNodePaletteDrag,
} from './canvas-node-drag'

function transfer(initial = ''): DataTransfer {
  let value = initial
  return {
    effectAllowed: 'all',
    types: initial ? [NODE_PALETTE_DRAG_TYPE] : [],
    setData: vi.fn((_type: string, next: string) => { value = next }),
    getData: vi.fn(() => value),
  } as unknown as DataTransfer
}

describe('canvas node drag contract', () => {
  it('writes the copy payload and reads it back', () => {
    const data = transfer()
    writeNodePaletteDrag(data, 'http')
    expect(data.effectAllowed).toBe('copy')
    expect(data.setData).toHaveBeenCalledWith(NODE_PALETTE_DRAG_TYPE, 'http')
    expect(readNodePaletteDrag(data)).toBe('http')
  })

  it('rejects empty or oversized payloads and detects the advertised type', () => {
    expect(readNodePaletteDrag(transfer('   '))).toBeNull()
    expect(readNodePaletteDrag(transfer('x'.repeat(65)))).toBeNull()
    expect(hasNodePaletteDrag(transfer('schedule'))).toBe(true)
    expect(hasNodePaletteDrag(transfer())).toBe(false)
  })
})
