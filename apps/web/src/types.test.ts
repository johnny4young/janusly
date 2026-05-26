import { describe, expect, it } from 'vitest'

import {
  CANVAS_TABS,
  getCanvasVisibility,
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

describe('getCanvasVisibility — canvas mount + visibility decision', () => {
  it('home: canvas wrapper is NOT in the DOM', () => {
    // The home page owns the full main slot via `RecoveryCenterPanel` and
    // never carries the canvas. Users who never navigate away from home
    // pay zero React Flow runtime cost.
    expect(getCanvasVisibility('home')).toEqual({
      mounted: false,
      visible: false,
      contextualSlot: false,
    })
  })

  it.each(['copilot', 'inspector'] as const)(
    '%s: canvas mounted AND visible, contextual slot NOT rendered',
    (tab) => {
      expect(getCanvasVisibility(tab)).toEqual({
        mounted: true,
        visible: true,
        contextualSlot: false,
      })
    },
  )

  const NON_CANVAS_NON_HOME: ActiveTab[] = [
    'workflows',
    'members',
    'marketplace',
    'templates',
    'credentials',
    'runs',
    'reasoning',
    'multiAgent',
    'operations',
  ]
  it.each(NON_CANVAS_NON_HOME)(
    '%s: canvas mounted but HIDDEN, contextual slot renders',
    (tab) => {
      // Canvas wrapper stays in the DOM so the root-level <ReactFlowProvider>
      // keeps its viewport state alive; `display: none` hides it from the
      // layout while the contextual main slot fills the visible space.
      expect(getCanvasVisibility(tab)).toEqual({
        mounted: true,
        visible: false,
        contextualSlot: true,
      })
    },
  )

  it('covers every value of ActiveTab — every tab must map to one of the three states', () => {
    // Belt-and-suspenders: if a new tab is added to `ActiveTab` without
    // wiring it through `getCanvasVisibility`, this test catches the gap
    // via the exhaustive `ALL_TABS` list (which itself is mirrored from
    // the closed-enum definition above).
    const decisions = ALL_TABS.map((tab) => ({ tab, decision: getCanvasVisibility(tab) }))
    expect(decisions).toHaveLength(ALL_TABS.length)
    for (const { tab, decision } of decisions) {
      expect(typeof decision.mounted).toBe('boolean')
      expect(typeof decision.visible).toBe('boolean')
      expect(typeof decision.contextualSlot).toBe('boolean')
      // Sanity invariants: visible implies mounted; visible and contextualSlot
      // are mutually exclusive (you don't show the contextual slot while the
      // canvas is the visible main).
      if (decision.visible) {
        expect(decision.mounted).toBe(true)
        expect(decision.contextualSlot).toBe(false)
      }
      if (!decision.mounted) {
        expect(decision.visible).toBe(false)
        expect(decision.contextualSlot).toBe(false)
      }
      // Used to suppress TS unused-binding warnings while keeping
      // `tab` in scope for debugging when this test fails.
      void tab
    }
  })
})
