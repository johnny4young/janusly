import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { userEvent } from 'vitest/browser'

import { flowRowProps } from '../test/flow-row-fixture'
import type { SavedWorkflow } from '../types'
import { FlowRow } from './FlowRow'

vi.mock('./WorkflowHealthBadge', () => ({ WorkflowHealthBadge: () => null }))
vi.mock('./FlowHealthTrend', () => ({ FlowHealthTrend: () => null }))

function mount(status: SavedWorkflow['status'] = 'active') {
  const onOpen = vi.fn()
  const pauseWorkflow = vi.fn()
  const deleteWorkflow = vi.fn()
  const workflow = { id: 'menu-workflow', orgId: 'org-menu', name: 'Menu workflow', status }
  render(<table><tbody><FlowRow {...flowRowProps(workflow, { onOpen, pauseWorkflow, deleteWorkflow })} /></tbody></table>)
  return { onOpen, pauseWorkflow, deleteWorkflow }
}

describe('workflow row menu keyboard contract', () => {
  it('starts on Pause, reaches Trash by keyboard, and restores the trigger on Escape', async () => {
    const { onOpen, pauseWorkflow, deleteWorkflow } = mount()
    const trigger = screen.getByTestId('workflows-row-menu-menu-workflow')
    await userEvent.click(trigger)
    const pause = screen.getByTestId('workflows-pause-menu-workflow')
    const trash = screen.getByTestId('workflows-move-to-trash-menu-workflow')
    expect(pause).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(trash).toHaveFocus()
    await userEvent.keyboard('{ArrowUp}')
    expect(pause).toHaveFocus()
    await userEvent.keyboard('{End}')
    expect(trash).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
    expect(onOpen).not.toHaveBeenCalled()
    expect(pauseWorkflow).not.toHaveBeenCalled()
    expect(deleteWorkflow).not.toHaveBeenCalled()
  })

  it('keeps Trash as the first item for a manually paused workflow', async () => {
    mount('paused_manual')
    const trigger = screen.getByTestId('workflows-row-menu-menu-workflow')
    trigger.focus()
    await userEvent.keyboard('{ArrowDown}')
    expect(screen.queryByTestId('workflows-pause-menu-workflow')).not.toBeInTheDocument()
    expect(screen.getByTestId('workflows-move-to-trash-menu-workflow')).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
  })

  it('activates Pause by keyboard without opening or trashing the workflow', async () => {
    const { onOpen, pauseWorkflow, deleteWorkflow } = mount()
    const trigger = screen.getByTestId('workflows-row-menu-menu-workflow')
    trigger.focus()
    await userEvent.keyboard('{ArrowDown}{Enter}')
    expect(pauseWorkflow).toHaveBeenCalledExactlyOnceWith('menu-workflow')
    expect(onOpen).not.toHaveBeenCalled()
    expect(deleteWorkflow).not.toHaveBeenCalled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })
})
