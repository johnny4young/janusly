import { describe, expect, it } from 'vitest'
import {
  UNGROUPED_FOLDER,
  updateCollapsedFolders,
} from './workflows-dashboard-model'

describe('workflows dashboard model', () => {
  it('uses a non-colliding sentinel for the synthetic ungrouped folder', () => {
    expect(UNGROUPED_FOLDER).toBe('')
  })

  it('updates collapsed folders without allocating for native no-op toggles', () => {
    const collapsed = ['finance']

    expect(updateCollapsedFolders(collapsed, 'finance', false)).toBe(collapsed)
    expect(updateCollapsedFolders(collapsed, 'finance', true)).toEqual([])
    expect(updateCollapsedFolders(collapsed, 'support', false)).toEqual([
      'finance',
      'support',
    ])
  })
})
