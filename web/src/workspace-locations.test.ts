import { describe, expect, it } from 'vitest'

import {
  listWorkspaceSections,
  resolveWorkspaceDestinationTarget,
  workspaceDestinationForTab,
  workspaceSectionForTab,
} from './workspace-locations'
import type { ActiveTab } from './types'

describe('workspace locations', () => {
  it('maps every internal tab into one of four user-facing destinations', () => {
    const expected: Record<ActiveTab, string> = {
      home: 'home',
      workflows: 'workflows',
      'ai-studio': 'workflows',
      inspector: 'workflows',
      templates: 'workflows',
      packs: 'workflows',
      experiments: 'workflows',
      runs: 'activity',
      recover: 'activity',
      reasoning: 'activity',
      multiAgent: 'activity',
      recoveryCase: 'activity',
      operations: 'settings',
      credentials: 'settings',
      members: 'settings',
      marketplace: 'settings',
    }

    for (const [tab, destination] of Object.entries(expected)) {
      expect(workspaceDestinationForTab(tab as ActiveTab)).toBe(destination)
    }
  })

  it('resolves a destination to its first permitted section', () => {
    expect(resolveWorkspaceDestinationTarget('workflows', ['ai.write'])).toBeNull()
    expect(resolveWorkspaceDestinationTarget('workflows', ['workflows.read'])).toBe('workflows')
    expect(resolveWorkspaceDestinationTarget('activity', ['recovery.read'])).toBe('recover')
    expect(resolveWorkspaceDestinationTarget('settings', ['credentials.read'])).toBe('credentials')
    expect(resolveWorkspaceDestinationTarget('settings', [])).toBeNull()
  })

  it('lists only the visible task-oriented sections', () => {
    expect(listWorkspaceSections('workflows', [
      'workflows.read',
      'ai.write',
      'evals.read',
      'packs.read',
    ]).map((section) => section.tab)).toEqual([
      'workflows',
      'inspector',
      'templates',
      'experiments',
    ])
    expect(listWorkspaceSections('activity', [
      'runs.read',
      'recovery.read',
      'workflows.read',
    ]).map((section) => section.tab)).toEqual([
      'runs',
    ])
  })

  it('retains the exact hidden subdestination as navigation context', () => {
    expect(workspaceSectionForTab('runs')?.tab).toBe('runs')
    expect(workspaceSectionForTab('recover')?.tab).toBe('recover')
    expect(workspaceSectionForTab('reasoning')?.tab).toBe('reasoning')
    expect(workspaceSectionForTab('multiAgent')?.tab).toBe('multiAgent')
    expect(workspaceSectionForTab('recoveryCase')?.tab).toBe('recover')
  })
})
