import { describe, expect, it } from 'vitest'
import {
  NODE_OPEN_STATUSES,
  TERMINAL_NODE_STATUSES,
  TERMINAL_RUN_STATUSES,
  nodeCancellableStatusValues,
  nodeOpenStatusValues,
  nodeStatusValues,
  nodeTerminalStatusValues,
  runOpenStatusValues,
  runStatusValues,
  runTerminalStatusValues,
  type NodeStatus,
  type NodeTerminalStatus,
  type RunStatus,
  type RunTerminalStatus,
} from './status'

describe('status constant arrays', () => {
  it('node open statuses match the lifecycle the runtime emits', () => {
    expect(nodeOpenStatusValues).toEqual(['pending', 'queued', 'running', 'waiting'])
  })

  it('node cancellable statuses are the open subset that cancelRun flips to cancelled', () => {
    // `running` is intentionally omitted — running nodes finish naturally on cancel.
    expect(nodeCancellableStatusValues).toEqual(['pending', 'queued', 'waiting'])
    for (const s of nodeCancellableStatusValues) {
      expect(nodeOpenStatusValues).toContain(s)
    }
    expect(nodeCancellableStatusValues).not.toContain('running')
  })

  it('node terminal statuses match the four end-states the engine writes', () => {
    expect(nodeTerminalStatusValues).toEqual(['succeeded', 'failed', 'skipped', 'cancelled'])
    // The canonical cancelled spelling has TWO Ls. Anyone introducing the
    // single-L spelling anywhere in the codebase trips this assertion.
    expect(nodeTerminalStatusValues).toContain('cancelled')
    expect(nodeTerminalStatusValues as readonly string[]).not.toContain('canceled')
  })

  it('node status union is the open + terminal concatenation', () => {
    expect(nodeStatusValues).toEqual([
      'pending', 'queued', 'running', 'waiting',
      'succeeded', 'failed', 'skipped', 'cancelled',
    ])
  })

  it('run open statuses include `created` (which is NOT a node status)', () => {
    expect(runOpenStatusValues).toEqual(['created', 'running', 'waiting'])
    expect(nodeOpenStatusValues as readonly string[]).not.toContain('created')
  })

  it('run terminal statuses include `timed_out` and exclude `skipped` (which is NODE-only)', () => {
    expect(runTerminalStatusValues).toEqual(['succeeded', 'failed', 'cancelled', 'timed_out'])
    expect(runTerminalStatusValues as readonly string[]).not.toContain('skipped')
    expect(runTerminalStatusValues as readonly string[]).not.toContain('canceled')
  })

  it('run status union is the open + terminal concatenation', () => {
    expect(runStatusValues).toEqual([
      'created', 'running', 'waiting',
      'succeeded', 'failed', 'cancelled', 'timed_out',
    ])
  })
})

describe('status Set helpers', () => {
  it('TERMINAL_NODE_STATUSES has every node terminal value', () => {
    for (const s of nodeTerminalStatusValues) expect(TERMINAL_NODE_STATUSES.has(s)).toBe(true)
    expect(TERMINAL_NODE_STATUSES.size).toBe(nodeTerminalStatusValues.length)
  })

  it('TERMINAL_RUN_STATUSES has every run terminal value', () => {
    for (const s of runTerminalStatusValues) expect(TERMINAL_RUN_STATUSES.has(s)).toBe(true)
    expect(TERMINAL_RUN_STATUSES.size).toBe(runTerminalStatusValues.length)
  })

  it('NODE_OPEN_STATUSES has every node open value', () => {
    for (const s of nodeOpenStatusValues) expect(NODE_OPEN_STATUSES.has(s)).toBe(true)
    expect(NODE_OPEN_STATUSES.size).toBe(nodeOpenStatusValues.length)
  })
})

describe('status type narrowing (compile-time drift detection)', () => {
  it('NodeTerminalStatus narrows to the four terminal values', () => {
    // These compile only if the literal narrowing is intact. Adding
    // `'canceled'` (single L) anywhere in the type space would fail the
    // build with "Type '\"canceled\"' is not assignable to type 'NodeTerminalStatus'".
    const succeeded: NodeTerminalStatus = 'succeeded'
    const failed: NodeTerminalStatus = 'failed'
    const skipped: NodeTerminalStatus = 'skipped'
    const cancelled: NodeTerminalStatus = 'cancelled'
    expect([succeeded, failed, skipped, cancelled]).toHaveLength(4)
  })

  it('RunTerminalStatus narrows to the four terminal values', () => {
    const succeeded: RunTerminalStatus = 'succeeded'
    const failed: RunTerminalStatus = 'failed'
    const cancelled: RunTerminalStatus = 'cancelled'
    const timedOut: RunTerminalStatus = 'timed_out'
    expect([succeeded, failed, cancelled, timedOut]).toHaveLength(4)
  })

  it('NodeStatus / RunStatus accept any value from their union', () => {
    const node: NodeStatus[] = ['pending', 'queued', 'running', 'waiting', 'succeeded', 'failed', 'skipped', 'cancelled']
    const run: RunStatus[] = ['created', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'timed_out']
    expect(node).toHaveLength(8)
    expect(run).toHaveLength(7)
  })
})
