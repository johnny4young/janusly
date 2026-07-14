/**
 * Rendering contract for the memoized workflow-list row.
 *
 * The Flows container updates its raw query on every keystroke. A row whose
 * props are unchanged must not render again, while a real row-state change
 * still has to reach the DOM.
 */

import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { SavedWorkflow } from '../types'
import { FlowRow, type FlowRowProps } from './FlowRow'

vi.mock('./WorkflowHealthBadge', () => ({ WorkflowHealthBadge: () => null }))

const noop = () => {}
const t = ((key: string) => key) as FlowRowProps['t']

function props(workflow: SavedWorkflow, selectedIds = new Set<string>()): FlowRowProps {
  return {
    workflow,
    folderOptions: [],
    tagOptions: [],
    hasFolders: false,
    selectionMode: true,
    selectedIds,
    draggingId: null,
    confirmDeleteId: null,
    onOpen: noop,
    toggleSelected: noop,
    setDraggingId: noop,
    setDropTarget: noop,
    setConfirmDeleteId: noop,
    setRowTag: noop,
    moveToFolder: noop,
    deleteWorkflow: noop,
    t,
  }
}

describe('<FlowRow /> memoization', () => {
  it('skips stable parent rerenders but renders a changed row-state prop', () => {
    let nameReads = 0
    const workflow = {
      id: 'wf-1',
      orgId: 'org-1',
      get name() {
        nameReads += 1
        return 'Billing sync'
      },
    } as SavedWorkflow
    const stableProps = props(workflow)
    const { rerender } = render(<FlowRow {...stableProps} />)
    const initialReads = nameReads

    rerender(<FlowRow {...stableProps} />)
    expect(nameReads).toBe(initialReads)

    rerender(<FlowRow {...stableProps} selectedIds={new Set(['wf-1'])} />)
    expect(nameReads).toBeGreaterThan(initialReads)
    expect(screen.getByRole('checkbox')).toBeChecked()
  })
})
