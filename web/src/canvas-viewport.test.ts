import { afterEach, describe, expect, it } from 'vitest'
import { readCanvasViewport, writeCanvasViewport } from './canvas-viewport'

const key = (id: string) => `janusly:canvasViewport:${id}`

afterEach(() => {
  window.localStorage.clear()
})

describe('canvas-viewport persistence', () => {
  it('round-trips a written viewport', () => {
    writeCanvasViewport('wf-1', { x: 12, y: -34, zoom: 0.75 })
    expect(readCanvasViewport('wf-1')).toEqual({ x: 12, y: -34, zoom: 0.75 })
  })

  it('returns null when no entry exists', () => {
    expect(readCanvasViewport('missing')).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    window.localStorage.setItem(key('wf-corrupt'), '{not json')
    expect(readCanvasViewport('wf-corrupt')).toBeNull()
  })

  it('returns null on a wrong-shaped object (missing field)', () => {
    window.localStorage.setItem(key('wf-partial'), JSON.stringify({ x: 1, y: 2 }))
    expect(readCanvasViewport('wf-partial')).toBeNull()
  })

  it('returns null on non-finite / non-number fields', () => {
    window.localStorage.setItem(key('wf-null'), JSON.stringify({ x: 1, y: 2, zoom: null }))
    expect(readCanvasViewport('wf-null')).toBeNull()
    // Number.isFinite (not the coercing global isFinite) rejects a string number.
    window.localStorage.setItem(key('wf-str'), JSON.stringify({ x: '1', y: 2, zoom: 1 }))
    expect(readCanvasViewport('wf-str')).toBeNull()
  })

  it('returns null on zero or negative zoom values', () => {
    window.localStorage.setItem(key('wf-zero'), JSON.stringify({ x: 1, y: 2, zoom: 0 }))
    expect(readCanvasViewport('wf-zero')).toBeNull()
    window.localStorage.setItem(key('wf-negative'), JSON.stringify({ x: 1, y: 2, zoom: -1 }))
    expect(readCanvasViewport('wf-negative')).toBeNull()
  })

  it('stores only the x/y/zoom triple (strips extra keys)', () => {
    const dirty = { x: 1, y: 2, zoom: 1, extra: 'nope' } as Parameters<typeof writeCanvasViewport>[1]
    writeCanvasViewport('wf-extra', dirty)
    expect(JSON.parse(window.localStorage.getItem(key('wf-extra'))!)).toEqual({ x: 1, y: 2, zoom: 1 })
  })

  it('keys entries per workflow id', () => {
    writeCanvasViewport('wf-a', { x: 1, y: 1, zoom: 1 })
    writeCanvasViewport('wf-b', { x: 2, y: 2, zoom: 2 })
    expect(readCanvasViewport('wf-a')).toEqual({ x: 1, y: 1, zoom: 1 })
    expect(readCanvasViewport('wf-b')).toEqual({ x: 2, y: 2, zoom: 2 })
  })
})
