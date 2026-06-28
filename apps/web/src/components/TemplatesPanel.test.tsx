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

describe('<TemplatesPanel />', () => {
  it('offers a Copilot CTA when no templates are loaded', () => {
    render(<TemplatesPanel templates={[]} onUseTemplate={vi.fn()} />)
    expect(screen.getByTestId('empty-state-cta')).toHaveTextContent('Generate one with Copilot')
  })

  it('filters by search and offers clear-filter when nothing matches', () => {
    render(
      <TemplatesPanel
        templates={[makeTemplate('t1', 'Invoice sync'), makeTemplate('t2', 'Lead router')]}
        onUseTemplate={vi.fn()}
      />,
    )
    expect(screen.getByText('Invoice sync')).toBeInTheDocument()
    expect(screen.getByText('Lead router')).toBeInTheDocument()

    const input = screen.getByPlaceholderText('Search templates…')
    fireEvent.change(input, { target: { value: 'invoice' } })
    expect(screen.getByText('Invoice sync')).toBeInTheDocument()
    expect(screen.queryByText('Lead router')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: 'zzz-nope' } })
    expect(screen.getByText('No templates match')).toBeInTheDocument()

    // Clearing the filter restores the full list.
    fireEvent.click(screen.getByTestId('empty-state-cta'))
    expect(screen.getByText('Invoice sync')).toBeInTheDocument()
    expect(screen.getByText('Lead router')).toBeInTheDocument()
  })
})
