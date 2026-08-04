import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Template } from '../types'
import { TemplatesPanel } from './RightPanel'

function makeTemplate(id: string, name: string): Template {
  return {
    id,
    name,
    description: `${name} flow`,
    category: 'ops',
    workflow: { nodes: [], edges: [] } as unknown as Template['workflow'],
  }
}

const catalogProps = {
  solutionPacks: [],
  credentials: [],
  onInstallPack: vi.fn(),
  onSampleRunPack: vi.fn(),
  onInjectPackFailure: vi.fn(),
}

describe('<TemplatesPanel />', () => {
  it('offers a AI Studio CTA when no templates are loaded', () => {
    render(<TemplatesPanel templates={[]} onUseTemplate={vi.fn()} {...catalogProps} />)
    expect(screen.getByTestId('empty-state-cta')).toHaveTextContent('Generate one with AI Studio')
  })

  it('filters recipes with the shared catalog search', async () => {
    render(
      <TemplatesPanel
        templates={[makeTemplate('t1', 'Invoice sync'), makeTemplate('t2', 'Lead router')]}
        onUseTemplate={vi.fn()}
        {...catalogProps}
      />,
    )
    expect(await screen.findByText('Invoice sync')).toBeInTheDocument()
    expect(screen.getByText('Lead router')).toBeInTheDocument()

    const input = screen.getByPlaceholderText('Search templates…')
    fireEvent.change(input, { target: { value: 'invoice' } })
    expect(screen.getByText('Invoice sync')).toBeInTheDocument()
    expect(screen.queryByText('Lead router')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'zzz-nope' } })
    expect(screen.getByText('No recipes match this search.')).toBeInTheDocument()

    // Clearing the shared catalog search restores the full recipe list.
    fireEvent.change(input, { target: { value: '' } })
    expect(screen.getByText('Invoice sync')).toBeInTheDocument()
    expect(screen.getByText('Lead router')).toBeInTheDocument()
  })
})
