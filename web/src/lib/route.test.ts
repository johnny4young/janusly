import { afterEach, describe, expect, it, vi } from 'vitest'
import { ROUTE_EVENT, ROUTE_TABS, formatRoute, onRouteChange, parseRoute, readRoute, writeRoute } from './route'

afterEach(() => {
  window.history.replaceState(null, '', '/')
})

describe('workspace route', () => {
  it('round-trips every tab a bare hash can name', () => {
    for (const tab of ROUTE_TABS) {
      if (tab === 'recoveryCase') continue
      expect(parseRoute(formatRoute({ tab }))).toEqual({ tab })
    }
  })

  it('spells the contextual routes and reads them back', () => {
    const cases = [
      { tab: 'recoveryCase', recoveryCaseId: 'case 42/x' },
      { tab: 'runs', queueFocus: true },
      { tab: 'runs', deadLetterId: 'dl-7' },
      { tab: 'runs', focusDay: '2026-09-04' },
      { tab: 'operations', opsSection: 'ai' },
    ] as const
    for (const route of cases) {
      expect(parseRoute(formatRoute(route))).toEqual(route)
    }
    expect(formatRoute({ tab: 'recoveryCase', recoveryCaseId: 'case 42/x' })).toBe('#/recoveryCase/case%2042%2Fx')
  })

  it('refuses anything it did not spell', () => {
    for (const hash of ['', '#', '#/', '#/nope', '/runs', '#/runs/dlq/a/b', '#/runs/day', '#/runs/day/tomorrow',
      '#/runs/other/x', '#/recoveryCase', '#/recoveryCase/', '#/home/extra', '#/runs/dlq/%E0%A4%A',
      `#/recoveryCase/${'x'.repeat(257)}`]) {
      expect(parseRoute(hash), hash).toBeNull()
    }
  })

  it('writes the hash, announces it, and never duplicates history entries', () => {
    const seen = vi.fn()
    const stop = onRouteChange(seen)
    const before = window.history.length
    writeRoute({ tab: 'operations' })
    expect(window.location.hash).toBe('#/operations')
    writeRoute({ tab: 'operations' })
    expect(window.history.length).toBe(before + 1)
    writeRoute({ tab: 'operations', opsSection: 'ai' }, 'replace')
    expect(window.location.hash).toBe('#/operations/ai')
    expect(window.history.length).toBe(before + 1)
    expect(readRoute()).toEqual({ tab: 'operations', opsSection: 'ai' })
    expect(seen).toHaveBeenCalledTimes(2)
    stop()
    window.dispatchEvent(new CustomEvent(ROUTE_EVENT))
    expect(seen).toHaveBeenCalledTimes(2)
  })
})
