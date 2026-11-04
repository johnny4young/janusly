import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ToolsPanel } from './ToolsPanel'

vi.mock('../api', () => ({ api: vi.fn().mockResolvedValue({ pluginIds: [] }) }))

const tools = ['a.one', 'b.one', 'c.one', 'd.one'].map(name => ({
  name, description: name, inputFields: [], writeSide: false,
}))

const columnsAt = async (width: number) => {
  const { unmount } = render(
    <div style={{ width }}><ToolsPanel tools={tools} onInstallPlugin={vi.fn()} canInstall /></div>,
  )
  const grid = (await screen.findByTestId('tools-group-a')).parentElement as HTMLElement
  const columns = getComputedStyle(grid).gridTemplateColumns.split(' ').length
  unmount()
  return columns
}

describe('<ToolsPanel /> layout', () => {
  it('uses three columns and narrows with its container', async () => {
    expect(await columnsAt(1000)).toBe(3)
    expect(await columnsAt(600)).toBe(2)
    expect(await columnsAt(400)).toBe(1)
  })
})
