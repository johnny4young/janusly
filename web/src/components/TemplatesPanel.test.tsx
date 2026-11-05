import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { act, cleanup, render, screen, fireEvent, within } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { SolutionPackPublic, Template } from '../types'
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

function makePack(id: string, name: string, drillLabel: string): SolutionPackPublic {
  return {
    id,
    name,
    description: `${name} pack`,
    category: 'incident_triage',
    version: '1.0.0',
    assurance: { intentContract: false, recoveryContractVersion: '2', qualificationFixtureCount: 0 },
    requiredCredentials: [],
    requiredOrgConfigs: [],
    nodeCount: 2,
    sampleCount: 0,
    failureCount: 1,
    samplePayloadIds: [],
    failureFixtureIds: ['drill'],
    failureFixtures: [{ id: 'drill', label: drillLabel, description: 'Controlled failure.', failureMode: 'credential_unavailable', recoveryPath: 'runtime_failure' }],
  }
}

function chipCount(testId: string): number {
  return Number(within(screen.getByTestId(testId)).getByText(/^\d+$/).textContent)
}

function recipeCards(): HTMLElement[] {
  return screen.queryAllByTestId(/^template-recipe-/)
}

const catalogProps = {
  solutionPacks: [],
  credentials: [],
  onInstallPack: vi.fn(),
  onSampleRunPack: vi.fn(),
  onInjectPackFailure: vi.fn(),
}

describe('<TemplatesPanel />', () => {
  // The recipe catalog is lazy: resolve it once so each test can render synchronously.
  beforeAll(async () => {
    render(<TemplatesPanel templates={[makeTemplate('t0', 'Preload')]} onUseTemplate={vi.fn()} {...catalogProps} />)
    await screen.findByTestId('template-recipe-t0')
    cleanup()
  })

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

  describe('category chips', () => {
    const shipped = JSON.parse(
      readFileSync(resolve(process.cwd(), '../internal/httpapi/assets/templates.json'), 'utf8'),
    ) as Template[]

    it('reaches every shipped recipe through its category chip and counts it there', () => {
      render(<TemplatesPanel templates={shipped} onUseTemplate={vi.fn()} {...catalogProps} />)
      expect(chipCount('template-category-all')).toBe(shipped.length)
      expect(recipeCards()).toHaveLength(shipped.length)

      const reached = new Set<string>()
      for (const code of new Set(shipped.map(template => template.categoryCode ?? template.category))) {
        const chip = screen.getByTestId(`template-category-${code}`)
        fireEvent.click(chip)
        expect(chip).toHaveAttribute('aria-pressed', 'true')
        const expected = shipped.filter(template => (template.categoryCode ?? template.category) === code)
        expect(recipeCards()).toHaveLength(expected.length)
        expect(chipCount(`template-category-${code}`)).toBe(expected.length)
        expected.forEach(template => {
          expect(screen.getByTestId(`template-recipe-${template.id}`)).toBeInTheDocument()
          reached.add(template.id)
        })
      }
      expect(reached.size).toBe(shipped.length)

      fireEvent.click(screen.getByTestId('template-category-all'))
      expect(recipeCards()).toHaveLength(shipped.length)
    })

    it('counts the search result per chip and keeps chips that drop to zero', () => {
      render(
        <TemplatesPanel
          templates={[makeTemplate('t1', 'Invoice sync'), { ...makeTemplate('t2', 'Lead router'), category: 'sales' }]}
          onUseTemplate={vi.fn()}
          {...catalogProps}
        />,
      )
      fireEvent.change(screen.getByPlaceholderText('Search templates…'), { target: { value: 'invoice' } })
      expect(chipCount('template-category-all')).toBe(1)
      expect(chipCount('template-category-ops')).toBe(1)
      expect(chipCount('template-category-sales')).toBe(0)
      expect(chipCount('template-view-recipes')).toBe(1)

      fireEvent.click(screen.getByTestId('template-category-sales'))
      expect(recipeCards()).toHaveLength(0)
      expect(screen.getByText('No recipes match this search.')).toBeInTheDocument()
    })

    it('labels chips in the active language', async () => {
      await changeRuntimeLocale('es')
      try {
        render(<TemplatesPanel templates={shipped} onUseTemplate={vi.fn()} {...catalogProps} />)
        expect(screen.getByTestId('template-category-all')).toHaveTextContent('Todas')
        expect(screen.getByTestId('template-category-revenue')).toHaveTextContent('Ingresos')
      } finally {
        await act(() => changeRuntimeLocale('en'))
      }
    })
  })

  describe('recipe cards', () => {
    const recipe: Template = {
      ...makeTemplate('flow', 'Flow'),
      workflow: {
        nodes: [
          { id: 'a', type: 'http' },
          { id: 'b', type: 'ai' },
          { id: 'c', type: 'approval' },
        ],
        edges: [],
      } as unknown as Template['workflow'],
    }

    it('draws one labelled icon per step, in workflow order', () => {
      render(<TemplatesPanel templates={[recipe]} onUseTemplate={vi.fn()} {...catalogProps} />)
      const steps = screen.getByTestId('template-recipe-flow').querySelectorAll('.we-recipe-card__step')
      expect([...steps].map(step => step.getAttribute('title'))).toEqual(['Call an API', 'AI prompt', 'Ask approval'])
      expect([...steps].every(step => step.querySelector('svg'))).toBe(true)
    })

    it('uses the recipe on click and stays disabled without write permission', () => {
      const onUseTemplate = vi.fn()
      const { rerender } = render(<TemplatesPanel templates={[recipe]} onUseTemplate={onUseTemplate} {...catalogProps} />)
      fireEvent.click(screen.getByTestId('template-recipe-flow'))
      expect(onUseTemplate).toHaveBeenCalledWith(recipe.workflow)

      rerender(<TemplatesPanel templates={[recipe]} onUseTemplate={onUseTemplate} canUse={false} {...catalogProps} />)
      expect(screen.getByTestId('template-recipe-flow')).toBeDisabled()
    })
  })

  describe('Packs view', () => {
    const packs = [makePack('alpha', 'Alpha', 'Secret gone'), makePack('beta', 'Beta', 'Worker lost')]
    const withPacks = { ...catalogProps, solutionPacks: packs }

    it('shows packs only in the Packs view, and every pack is there', async () => {
      render(<TemplatesPanel templates={[makeTemplate('t1', 'Invoice sync')]} onUseTemplate={vi.fn()} {...withPacks} />)
      expect(screen.queryByTestId('solution-pack-alpha')).not.toBeInTheDocument()
      expect(screen.getByTestId('template-view-recipes')).toHaveAttribute('aria-pressed', 'true')
      expect(chipCount('template-view-packs')).toBe(2)

      fireEvent.click(screen.getByTestId('template-view-packs'))
      expect(await screen.findByTestId('solution-pack-alpha')).toBeInTheDocument()
      expect(screen.getByTestId('solution-pack-beta')).toBeInTheDocument()
      expect(screen.getByTestId('template-view-packs')).toHaveAttribute('aria-pressed', 'true')
      expect(recipeCards()).toHaveLength(0)
      expect(screen.queryByTestId('template-category-all')).not.toBeInTheDocument()
    })

    it.each([['worker lost', ['beta']], ['alpha', ['alpha']], ['zzz-nope', []]])(
      'counts the same packs the view shows for the search %s',
      async (search, expected) => {
        render(<TemplatesPanel templates={[makeTemplate('t1', 'Invoice sync')]} onUseTemplate={vi.fn()} {...withPacks} />)
        fireEvent.change(screen.getByPlaceholderText('Search templates…'), { target: { value: search } })
        expect(chipCount('template-view-packs')).toBe(expected.length)

        fireEvent.click(screen.getByTestId('template-view-packs'))
        await screen.findByPlaceholderText('Search templates…')
        await vi.waitFor(() => {
          expect(screen.queryAllByTestId(/^solution-pack-/).map(pack => pack.dataset.testid))
            .toEqual(expected.map(id => `solution-pack-${id}`))
        })
      },
    )

    it('opens on the packs when no recipes are loaded', async () => {
      render(<TemplatesPanel templates={[]} onUseTemplate={vi.fn()} {...withPacks} />)
      expect(await screen.findByTestId('solution-pack-alpha')).toBeInTheDocument()
      expect(screen.getByTestId('template-view-packs')).toHaveAttribute('aria-pressed', 'true')
    })
  })
})
