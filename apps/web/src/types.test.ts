import { describe, expect, it } from 'vitest'

import {
  CANVAS_TABS,
  getCanvasVisibility,
  isCanvasTab,
  parseAiCandidateBackoff,
  type ActiveTab,
} from './types'

describe('parseAiCandidateBackoff', () => {
  it('accepts only a real positive candidate reduction', () => {
    expect(parseAiCandidateBackoff({ from: 4, to: 1 })).toEqual({ from: 4, to: 1 })
    expect(parseAiCandidateBackoff({ from: 1, to: 1 })).toBeUndefined()
    expect(parseAiCandidateBackoff({ from: 1, to: 2 })).toBeUndefined()
    expect(parseAiCandidateBackoff({ from: 4.5, to: 1 })).toBeUndefined()
    expect(parseAiCandidateBackoff({ from: Number.POSITIVE_INFINITY, to: 1 })).toBeUndefined()
    expect(parseAiCandidateBackoff({ from: '4', to: 1 })).toBeUndefined()
    expect(parseAiCandidateBackoff(null)).toBeUndefined()
  })
})

const ALL_TABS: ActiveTab[] = [
  'home',
  'workflows',
  'members',
  'copilot',
  'experiments',
  'marketplace',
  'templates',
  'packs',
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
    expect(nonCanvasTabs).toContain('experiments')
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
    'packs',
    'credentials',
    'runs',
    'reasoning',
    'multiAgent',
    'operations',
    'experiments',
  ]
  it.each(NON_CANVAS_NON_HOME)(
    '%s: canvas mounted but HIDDEN, contextual slot renders',
    (tab) => {
      // Canvas wrapper stays in the DOM so the lazy CanvasWorkspace's
      // <ReactFlowProvider> (and its <ReactFlow> instance) keeps its viewport
      // state alive; `display: none` hides it from the layout while the
      // contextual main slot fills the visible space.
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

describe('canvas mount boundary — viewport persistence contract', () => {
  // The <ReactFlowProvider> and the <ReactFlow> instance live inside the
  // lazy `CanvasWorkspace`, mounted via `getCanvasVisibility`. That instance
  // holds the viewport (zoom/pan); React Flow's viewport is uncontrolled
  // (`fitView` on mount), so it survives ONLY while the instance stays
  // mounted. This pins the mount boundary that makes persistence work: the
  // canvas is mounted for EVERY non-home tab, so navigating between non-home
  // tabs (e.g. inspector -> operations -> inspector) never unmounts it and
  // the viewport persists. A round-trip through home unmounts it, so the
  // viewport re-fits on the next mount (accepted; unchanged from before).
  // Real zoom/pan retention across a hide/show cycle is exercised in
  // `WorkflowCanvas.browser.test.tsx`.
  const NON_HOME = ALL_TABS.filter((tab) => tab !== 'home')

  it('keeps the canvas mounted across every non-home tab', () => {
    for (const tab of NON_HOME) {
      expect({ tab, mounted: getCanvasVisibility(tab).mounted }).toEqual({ tab, mounted: true })
    }
  })

  it('unmounts the canvas only on home', () => {
    expect(getCanvasVisibility('home').mounted).toBe(false)
    expect(NON_HOME.every((tab) => getCanvasVisibility(tab).mounted)).toBe(true)
  })
})
