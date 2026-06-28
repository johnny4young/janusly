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
    onWorkflowNameChange: vi.fn(),
    onAdd: vi.fn(),
    onValidate: vi.fn(),
    onSave: vi.fn(),
    onNew: vi.fn(),
    onStart: vi.fn(),
    onOpenTab: vi.fn(),
    ...overrides,
  }
  render(<BuilderSidebar {...props} />)
  return props
}

describe('<BuilderSidebar />', () => {
  beforeEach(() => {
    window.localStorage.clear()
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
})
