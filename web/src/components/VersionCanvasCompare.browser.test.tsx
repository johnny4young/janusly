import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { page } from 'vitest/browser'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import '../styles/canvas.css'
import '@xyflow/react/dist/style.css'
import { initI18n } from '../i18n'
import { useWorkflowStore } from '../store'
import type { WorkflowDefinition } from '../types'
import VersionCanvasCompare from './VersionCanvasCompare'

const before: WorkflowDefinition = {
  id: 'wf',
  name: 'Orders',
  nodes: [
    { id: 'call', type: 'http', label: 'Call API', config: { retry: { maxAttempts: 1 }, apiKey: 'hidden-value' } },
    { id: 'old', type: 'noop', label: 'Old step', config: {} },
  ],
  edges: [{ from: 'call', to: 'old' }],
  ui: { positions: { call: { x: 0, y: 0 }, old: { x: 0, y: 200 } } },
}
const after: WorkflowDefinition = {
  ...before,
  nodes: [
    { id: 'call', type: 'http', label: 'Call API', config: { retry: { maxAttempts: 3 }, apiKey: 'hidden-value' } },
    { id: 'fresh', type: 'approval', label: 'New step', config: {} },
  ],
  edges: [{ from: 'call', to: 'fresh' }],
  ui: { positions: { call: { x: 0, y: 0 }, fresh: { x: 0, y: 200 } } },
}

type Saved = { id: string; version: number; dagJson: WorkflowDefinition }
const pair: [Saved, Saved] = [{ id: 'one', version: 1, dagJson: before }, { id: 'two', version: 2, dagJson: after }]
const history = [pair[1], pair[0]]

function mount(sides: [Saved, Saved] | null = pair, withHost = true) {
  const onClose = vi.fn()
  const view = render(
    <div>
      {withHost && <div className="canvas-frame" data-mode="author" style={{ width: 1024, height: 720, position: 'relative' }} />}
      <button type="button" data-testid="opener">open</button>
    </div>,
  )
  screen.getByTestId('opener').focus()
  const compare = () => <VersionCanvasCompare pair={sides} history={history} onClose={onClose} />
  view.rerender(
    <div>
      {withHost && <div className="canvas-frame" data-mode="author" style={{ width: 1024, height: 720, position: 'relative' }} />}
      <button type="button" data-testid="opener">open</button>
      {compare()}
    </div>,
  )
  return { onClose, view }
}

beforeAll(async () => { await initI18n('en') })
afterEach(() => {
  cleanup()
  useWorkflowStore.setState({ canvasCovered: false, workflowDirty: false })
})

describe('VersionCanvasCompare', () => {
  it('marks new, modified and deleted steps and counts every change', async () => {
    mount()
    await expect.element(page.getByTestId('version-compare')).toBeVisible()
    expect(screen.getByTestId('version-compare-title')).toHaveTextContent('Compare v1 ↔ v2')
    expect(screen.getByTestId('version-compare-count')).toHaveTextContent('5 changes')
    expect(screen.getByTestId('version-compare-count-added')).toHaveTextContent('N 2')
    expect(screen.getByTestId('version-compare-count-changed')).toHaveTextContent('M 1')
    expect(screen.getByTestId('version-compare-count-removed')).toHaveTextContent('D 2')
    await vi.waitFor(() => expect(screen.getAllByTestId('version-compare-mark').map(mark => mark.textContent).sort()).toEqual(['D', 'M', 'N']))
    expect(document.querySelector('.canvas-frame [data-testid="version-compare"]')).not.toBeNull()
    await vi.waitFor(() => {
      expect(document.querySelector('.version-compare-edge[data-mark="added"] .we-edge')).not.toBeNull()
      expect(document.querySelector('.version-compare-edge[data-mark="removed"] .we-edge')).not.toBeNull()
    })
  })

  it('never paints a leading accent on a marked step', async () => {
    mount()
    await vi.waitFor(() => expect(document.querySelector('.version-compare-node[data-mark="added"] .workflow-node')).not.toBeNull())
    for (const element of document.querySelectorAll('.version-compare, .version-compare *')) {
      const style = getComputedStyle(element)
      const onlyLeading = Number.parseFloat(style.borderLeftWidth) >= 2 && Number.parseFloat(style.borderRightWidth) === 0
      expect(onlyLeading).toBe(false)
    }
  })

  it('walks the changes and shows before and after JSON with the secret masked', async () => {
    mount()
    await vi.waitFor(() => expect(screen.getByTestId('version-compare-detail')).toBeInTheDocument())
    expect(screen.getByTestId('version-compare-detail')).toHaveTextContent('New step · New')
    expect(screen.queryByTestId('version-compare-json-before')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('version-compare-next'))
    expect(screen.getByTestId('version-compare-detail')).toHaveTextContent('Old step · Deleted')
    expect(screen.queryByTestId('version-compare-json-after')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('version-compare-next'))
    expect(screen.getByTestId('version-compare-detail')).toHaveTextContent('Call API · Modified')
    const changed = (side: string) => [...screen.getByTestId(`version-compare-json-${side}`).querySelectorAll('[data-changed="true"]')].map(line => line.textContent?.trim())
    expect(changed('before')).toEqual(['"maxAttempts": 1'])
    expect(changed('after')).toEqual(['"maxAttempts": 3'])
    expect(screen.getByTestId('version-compare-detail').textContent).not.toContain('hidden-value')
    fireEvent.click(screen.getByTestId('version-compare-prev'))
    expect(screen.getByTestId('version-compare-detail')).toHaveTextContent('Old step · Deleted')
  })

  it('frames the change it steps to', async () => {
    mount()
    const transform = () => document.querySelector<HTMLElement>('.version-compare .react-flow__viewport')?.style.transform
    await vi.waitFor(() => expect(transform()).toContain('scale'))
    await vi.waitFor(() => expect(document.querySelector('.react-flow__node[data-id="fresh"]')).toBeVisible())
    await new Promise(resolve => setTimeout(resolve, 100))
    const whole = transform()
    fireEvent.click(screen.getByTestId('version-compare-next'))
    await vi.waitFor(() => expect(transform()).not.toBe(whole))
    expect(transform()).toContain('scale(1)')
  })

  it('selects a changed step clicked on the graph', async () => {
    mount()
    await vi.waitFor(() => expect(document.querySelector('.react-flow__node[data-id="call"]')).not.toBeNull())
    fireEvent.click(document.querySelector('.react-flow__node[data-id="call"]')!)
    expect(screen.getByTestId('version-compare-detail')).toHaveTextContent('Call API · Modified')
  })

  it('covers the editor while open and returns focus when closed', async () => {
    const { onClose, view } = mount()
    await vi.waitFor(() => expect(useWorkflowStore.getState().canvasCovered).toBe(true))
    expect(screen.getByTestId('version-compare')).toHaveFocus()
    fireEvent.click(screen.getByTestId('version-compare-close'))
    expect(onClose).toHaveBeenCalledOnce()
    const host = <div className="canvas-frame" data-mode="author" style={{ width: 1024, height: 720, position: 'relative' }} />
    act(() => view.rerender(<div>{host}<button type="button" data-testid="opener">open</button></div>))
    expect(useWorkflowStore.getState().canvasCovered).toBe(false)
    expect(screen.getByTestId('opener')).toHaveFocus()
  })

  it('compares a snapshot of the draft with the version it was loaded from', async () => {
    useWorkflowStore.getState().hydrateWorkflow(after, { saved: true, dirty: true, version: { id: 'one', version: 1 } })
    mount(null)
    await expect.element(page.getByTestId('version-compare-title')).toHaveTextContent('Compare v1 ↔ Draft')
    expect(screen.getByTestId('version-compare-count')).toHaveTextContent('5 changes')
    act(() => useWorkflowStore.getState().hydrateWorkflow(before, { saved: true, dirty: true }))
    expect(screen.getByTestId('version-compare-count')).toHaveTextContent('5 changes')
  })

  it('compares a draft with the latest version when it has no loaded source', async () => {
    useWorkflowStore.getState().hydrateWorkflow(after, { saved: true, dirty: true })
    mount(null)
    await expect.element(page.getByTestId('version-compare-title')).toHaveTextContent('Compare v2 ↔ Draft')
  })

  it('says so when only workflow fields differ', async () => {
    mount([pair[0], { id: 'two', version: 2, dagJson: { ...before, name: 'Renamed' } }])
    await expect.element(page.getByTestId('version-compare-empty')).toHaveTextContent('No changes to steps or paths')
    expect(screen.queryByTestId('version-compare-next')).not.toBeInTheDocument()
    expect(screen.queryByTestId('version-compare-detail')).not.toBeInTheDocument()
  })

  it('closes a draft comparison once the draft is saved', async () => {
    useWorkflowStore.getState().hydrateWorkflow(after, { saved: true, dirty: true })
    const { onClose } = mount(null)
    await expect.element(page.getByTestId('version-compare')).toBeVisible()
    expect(onClose).not.toHaveBeenCalled()
    act(() => useWorkflowStore.setState({ workflowDirty: false }))
    expect(onClose).toHaveBeenCalled()
  })

  it('renders nothing and leaves the editor usable without an author canvas to cover', async () => {
    mount(pair, false)
    expect(screen.queryByTestId('version-compare')).not.toBeInTheDocument()
    expect(useWorkflowStore.getState().canvasCovered).toBe(false)
  })
})
