import { describe, expect, it } from 'vitest'

import {
  CANVAS_TABS,
  isCanvasTab,
  type ActiveTab,
} from './types'

const ALL_TABS: ActiveTab[] = [
  'home',
  'workflows',
  'members',
  'copilot',
  'marketplace',
  'templates',
  'credentials',
  'inspector',
  'runs',
  'reasoning',
  'multiAgent',
  'operations',
]

describe('CANVAS_TABS contract', () => {
  it('exposes exactly the two tabs that need the React Flow canvas', () => {
    // Stable list: AI Studio (drag-and-drop authoring) + Inspector
    // (node-click selection). Adding a tab here costs an extra
    // canvas mount; removing one drops a layout case from the
    // contextual main-slot path. Either direction is intentional.
    expect(CANVAS_TABS).toEqual(['copilot', 'inspector'])
  })

  it('isCanvasTab returns true ONLY for the canvas tabs', () => {
    const canvasTabs = ALL_TABS.filter(isCanvasTab)
    expect(canvasTabs.sort()).toEqual(['copilot', 'inspector'])
  })

  it('isCanvasTab returns false for every non-canvas tab (including home)', () => {
    const nonCanvasTabs = ALL_TABS.filter((tab) => !isCanvasTab(tab))
    // home owns its own dedicated branch (`RecoveryCenterPanel`) and
    // is NOT a canvas tab even though it doesn't render in the
    // contextual main-slot path.
    expect(nonCanvasTabs).toContain('home')
    expect(nonCanvasTabs).toContain('operations')
    expect(nonCanvasTabs).toContain('credentials')
    expect(nonCanvasTabs).toContain('members')
    expect(nonCanvasTabs).toContain('templates')
    expect(nonCanvasTabs).toContain('marketplace')
    expect(nonCanvasTabs).toContain('runs')
    expect(nonCanvasTabs).toContain('multiAgent')
    expect(nonCanvasTabs).toContain('workflows')
    expect(nonCanvasTabs).toContain('reasoning')
  })

  it.each(ALL_TABS)('isCanvasTab(%s) is a closed boolean (never throws)', (tab) => {
    expect(typeof isCanvasTab(tab)).toBe('boolean')
  })
})
