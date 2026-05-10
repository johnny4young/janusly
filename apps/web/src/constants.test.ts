/**
 * Pins the node-type catalogue helpers used by the Inspector + canvas.
 * Adding a new node type means extending the runtime union, the preset map,
 * the display map, and the config-summary helper — these tests catch the
 * cases where one of those forgets to land.
 */
import { describe, expect, it } from 'vitest'
import { nodePresets, nodeTypes, getNodeLabel, getNodeHelper, getNodeConfigSummary } from './constants'

describe('node-type catalogue', () => {
  it('declares parallel_fork and join in the preset map and ordered list', () => {
    expect(nodePresets.parallel_fork).toEqual({ branches: [{ label: 'a' }, { label: 'b' }] })
    expect(nodePresets.join).toEqual({ sources: { a: '', b: '' } })
    expect(nodeTypes).toContain('parallel_fork')
    expect(nodeTypes).toContain('join')
  })

  it('exposes display labels and helpers for parallel_fork / join', () => {
    expect(getNodeLabel('parallel_fork')).toBe('Fan out')
    expect(getNodeLabel('join')).toBe('Merge branches')
    expect(getNodeHelper('parallel_fork')).toBe('Run named branches in parallel')
    expect(getNodeHelper('join')).toBe('Gather labelled outputs from a fan-out')
  })

  describe('getNodeConfigSummary', () => {
    it('summarises parallel_fork by branch count', () => {
      expect(getNodeConfigSummary('parallel_fork', { branches: [{ label: 'a' }, { label: 'b' }, { label: 'c' }] }))
        .toBe('3 branches')
      expect(getNodeConfigSummary('parallel_fork', { branches: [{ label: 'only' }] }))
        .toBe('1 branch')
    })

    it('prompts the operator when parallel_fork has no branches yet', () => {
      expect(getNodeConfigSummary('parallel_fork', {})).toBe('Add at least 2 branches')
      expect(getNodeConfigSummary('parallel_fork', { branches: [] })).toBe('Add at least 2 branches')
    })

    it('summarises join by source count', () => {
      expect(getNodeConfigSummary('join', { sources: { a: 'http_a', b: 'http_b' } }))
        .toBe('Merging 2 branches')
      expect(getNodeConfigSummary('join', { sources: { a: 'only_one' } }))
        .toBe('Merging 1 branch')
    })

    it('prompts the operator when join sources are empty / missing', () => {
      expect(getNodeConfigSummary('join', {})).toBe('Map branches to predecessor nodes')
      expect(getNodeConfigSummary('join', { sources: {} })).toBe('Map branches to predecessor nodes')
    })

    it('ignores a non-object sources value defensively', () => {
      expect(getNodeConfigSummary('join', { sources: 'oops' })).toBe('Map branches to predecessor nodes')
      expect(getNodeConfigSummary('join', { sources: ['a', 'b'] })).toBe('Map branches to predecessor nodes')
    })
  })
})
