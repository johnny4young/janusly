import { act, render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Template } from '../types'
import { changeRuntimeLocale } from '../i18n'
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

  it('reprojects a recipe search in the active language without clearing the query', async () => {
    const template = {
      ...makeTemplate('incident-triage', 'Incident triage'),
      nameCode: 'incident-triage.name',
      descriptionCode: 'incident-triage.description',
    }
    await changeRuntimeLocale('en')
    render(<TemplatesPanel templates={[template]} onUseTemplate={vi.fn()} {...catalogProps} />)

    const input = screen.getByPlaceholderText('Search templates…')
    fireEvent.change(input, { target: { value: 'summarizes' } })
    expect(screen.getByText('Incident triage → GitHub + Slack')).toBeInTheDocument()

    try {
      await act(() => changeRuntimeLocale('es'))
      expect(input).toHaveValue('summarizes')
      expect(screen.getByText('Ninguna receta coincide con esta búsqueda.')).toBeInTheDocument()

      fireEvent.change(input, { target: { value: 'resume' } })
      expect(screen.getByText('Triage de incidentes → GitHub + Slack')).toBeInTheDocument()
    } finally {
      await act(() => changeRuntimeLocale('en'))
    }
  })
})
