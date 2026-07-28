import type { ComponentProps } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BuilderSidebar } from './BuilderSidebar'

type Deferred<T = void> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function renderSidebar(overrides: Partial<ComponentProps<typeof BuilderSidebar>> = {}) {
  const props: ComponentProps<typeof BuilderSidebar> = {
    activeTab: 'inspector',
    aiHealth: null,
    workflowName: 'Test workflow',
    streamStatus: 'idle',
    permissions: [
      'workflows.read', 'workflows.write', 'runs.read', 'runs.start', 'recovery.read',
      'ai.write', 'evals.read', 'packs.read', 'credentials.read', 'members.read',
    ],
    onWorkflowNameChange: vi.fn(),
    onAdd: vi.fn(),
    onValidate: vi.fn(),
    onSave: vi.fn(),
    onNew: vi.fn(),
    onStart: vi.fn(),
    onOpenTab: vi.fn(),
    onOpenHelp: vi.fn(),
    ...overrides,
  }
  render(<BuilderSidebar {...props} />)
  return props
}

describe('<BuilderSidebar />', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('hides unauthorized destinations and disables write actions', () => {
    renderSidebar({ permissions: ['workflows.read', 'runs.read'] })

    expect(screen.queryByRole('button', { name: /Credentials/ })).not.toBeInTheDocument()
    expect(screen.queryByText('AI operator')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled()
  })

  it('keeps the header action strip busy until an async action settles', async () => {
    const save = deferred()
    const onSave = vi.fn(() => save.promise)
    renderSidebar({ onSave })

    const saveButton = screen.getByRole('button', { name: 'Save' })
    const validateButton = screen.getByRole('button', { name: 'Validate' })
    const runButton = screen.getByRole('button', { name: 'Run' })

    fireEvent.click(saveButton)
    fireEvent.click(saveButton)

    expect(onSave).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(saveButton).toHaveAttribute('aria-busy', 'true'))
    expect(validateButton).toBeDisabled()
    expect(runButton).toBeDisabled()

    await act(async () => { save.resolve() })

    await waitFor(() => expect(saveButton).not.toBeDisabled())
    expect(saveButton).toHaveAttribute('aria-busy', 'false')
    expect(validateButton).not.toBeDisabled()
    expect(runButton).not.toBeDisabled()
  })

  it('keeps palette steps clickable while exposing a copy drag payload', () => {
    const props = renderSidebar()
    const setData = vi.fn()
    const dataTransfer = { setData, effectAllowed: 'all' } as unknown as DataTransfer
    const step = screen.getAllByRole('button', { name: 'Call an API' })[0]

    expect(step).toHaveAttribute('draggable', 'true')
    fireEvent.dragStart(step, { dataTransfer })
    expect(setData).toHaveBeenCalledWith('application/x-janusly-node-type', 'http')
    expect(dataTransfer.effectAllowed).toBe('copy')

    fireEvent.click(step)
    expect(props.onAdd).toHaveBeenCalledWith('http')
  })

  it('opens real keyboard help and does not render the dead whats-new affordance', () => {
    const props = renderSidebar()
    fireEvent.click(screen.getByRole('button', { name: 'Help' }))
    expect(props.onOpenHelp).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: "What's new" })).not.toBeInTheDocument()
  })

  it('keeps run evidence in one primary destination', () => {
    renderSidebar()

    expect(screen.getByRole('button', { name: /^Runs$/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Multi-agent timeline$/ })).not.toBeInTheDocument()
  })

  it('keeps operational task spaces primary and authoring chrome contextual', () => {
    renderSidebar({ activeTab: 'home' })

    expect(screen.getByRole('button', { name: /^Home/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Recover$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Workflows$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Runs$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Connections$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Operations$/ })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Call an API' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Search sections…' })).toBeInTheDocument()

    const advanced = screen.getByRole('button', { name: /^Advanced/ })
    expect(advanced).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(advanced)
    expect(screen.getByRole('button', { name: /^AI Studio/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Step setup$/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Team$/ })).toBeInTheDocument()
  })

  it('migrates stale navigation groups without hiding the primary workspace', () => {
    window.localStorage.setItem('janusly:sidebar:state', JSON.stringify({
      openGroups: ['pinned', 'build', 'run'],
      openCategories: ['ai'],
      collapsed: false,
    }))

    renderSidebar({ activeTab: 'home' })

    expect(screen.getByRole('button', { name: /Workspace/ }))
      .toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('button', { name: /^Recover$/ })).toBeInTheDocument()
  })
})
