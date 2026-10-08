import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiStudioPanel } from '../components/AiStudioPanel'
import { changeAppLanguage } from '../i18n'
import { useWorkflowStore } from '../store'
import type { AiStudioPanelProps } from '../components/ai-studio/model'
import type { AuthoringExperienceDecision } from '../lib/api-types.generated'
import { catalog, compilation, workflowProposal } from './ai-studio-fixtures'
import { deferred } from './deferred'

const initial = useWorkflowStore.getState()
const copy = {
  en: { compile: 'Compile intent brief', build: 'Build proposal', apply: 'Apply proposal to draft', name: 'Optional copied workflow name',
    modes: { REUSE: 'Reuse saved version', ADAPT: 'Adapt saved version name', GENERATE: 'Generate a new proposal', ESCALATE: 'More review needed' },
    unknown: 'Outcome evidence is unknown. Registration grants no approval and does not save or run a workflow.',
    reasons: { REUSE: 'Exact compatible example', ADAPT: 'Name-only adaptation', GENERATE: 'No exact example', ESCALATE: 'Ambiguous examples' } },
  es: { compile: 'Compilar brief de intención', build: 'Construir propuesta', apply: 'Aplicar propuesta al borrador', name: 'Nombre opcional del workflow copiado',
    modes: { REUSE: 'Reutilizar versión guardada', ADAPT: 'Adaptar nombre de versión guardada', GENERATE: 'Generar una propuesta nueva', ESCALATE: 'Se necesita más revisión' },
    unknown: 'La evidencia del resultado es desconocida. Registrar no otorga aprobación ni guarda o ejecuta un workflow.',
    reasons: { REUSE: 'Ejemplo compatible exacto', ADAPT: 'Adaptación solo del nombre', GENERATE: 'Sin ejemplo exacto', ESCALATE: 'Ejemplos ambiguos' } },
} as const
function decision(mode: AuthoringExperienceDecision['mode'], name = 'Reviewed rename'): AuthoringExperienceDecision {
  const common = { provider: 'rules' as const, policyVersion: 'authoring-experience-v1' as const,
    contextRevision: 'INTERNAL_CONTEXT_REVISION', catalogVersion: catalog.version, truncated: false as const, outcomeEvidence: 'unknown' as const }
  const source = { candidateId: 'example-3', workflowId: 'saved-workflow', versionId: 'immutable-version-3', version: 3 }
  if (mode === 'REUSE') return { ...common, mode, reason: 'exact_match', source, draftId: 'wf_proposed' }
  if (mode === 'ADAPT') return { ...common, mode, reason: 'descriptive_adaptation', source, draftId: 'wf_proposed', edits: [{ field: 'workflow_name', value: name }] }
  return mode === 'GENERATE' ? { ...common, mode, reason: 'no_exact_match' } : { ...common, mode, reason: 'ambiguous_match' }
}
function response(mode: AuthoringExperienceDecision['mode'], name?: string) {
  const result = workflowProposal({ mode: 'fallback', experienceDecision: decision(mode, name) })
  result.proposal.applicable = mode !== 'ESCALATE'
  if (mode === 'ADAPT') result.proposal.workflow.name = name ?? 'Reviewed rename'
  return result
}
function renderPanel(overrides: Partial<AiStudioPanelProps> = {}) {
  const props: AiStudioPanelProps = {
    health: null, workflowName: 'Current', actionRequest: null,
    onLoadAuthoringCapabilities: vi.fn(async () => catalog), onCompileWorkflowBrief: vi.fn(async () => compilation),
    onProposeWorkflow: vi.fn(async () => response('REUSE')), onApplyWorkflowProposal: vi.fn(async () => ({ status: 'applied' as const })),
    onExplainWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, explanation: '' })),
    onReviewWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, review: { status: 'pass' as const, issues: [] } })),
    onSuggestWorkflowImprovement: vi.fn(async () => ({ mode: 'fallback' as const, suggestions: [] })), onApplyWorkflowImprovement: vi.fn(async () => false),
    onViewCanvas: vi.fn(), onOpenRuns: vi.fn(), onOpenTemplates: vi.fn(), ...overrides,
  }
  return { ...render(<AiStudioPanel {...props} />), props }
}
async function propose(locale: keyof typeof copy) {
  await screen.findByTestId('capability-catalog-summary')
  fireEvent.click(screen.getByRole('button', { name: copy[locale].compile }))
  await screen.findByTestId('intent-brief')
  fireEvent.click(screen.getByRole('button', { name: copy[locale].build }))
  return await screen.findByTestId('workflow-proposal')
}
export function registerExperienceReviewCases() {
  describe('explicit experience proposal review', () => {
    beforeEach(() => useWorkflowStore.setState({ ...initial, currentWorkflowId: 'current', activeTab: 'ai-studio' }, true))
    for (const locale of ['en', 'es'] as const) {
      for (const mode of ['REUSE', 'ADAPT', 'GENERATE', 'ESCALATE'] as const) {
        it(`${locale} presents ${mode} and unknown outcome without inventing source or model evidence`, async () => {
          await changeAppLanguage(locale)
          const { props } = renderPanel({ onProposeWorkflow: vi.fn(async () => response(mode)) })
          const view = await propose(locale)
          const receipt = await screen.findByTestId('experience-review')
          expect(within(receipt).getByText(copy[locale].modes[mode])).toBeInTheDocument()
          expect(within(receipt).getByText(copy[locale].reasons[mode])).toBeInTheDocument()
          expect(within(receipt).getByText(copy[locale].unknown)).toBeInTheDocument()
          expect(within(receipt).getByText('authoring-experience-v1')).toBeInTheDocument()
          expect(screen.queryByText('INTERNAL_CONTEXT_REVISION')).not.toBeInTheDocument()
          if (mode === 'REUSE' || mode === 'ADAPT') {
            expect(within(receipt).getByText('saved-workflow')).toBeInTheDocument()
            expect(within(receipt).getByText('v3 · immutable-version-3')).toBeInTheDocument()
            expect(within(view).queryByText(locale === 'en' ? 'Local template' : 'Plantilla local')).not.toBeInTheDocument()
          } else expect(within(receipt).queryByText('immutable-version-3')).not.toBeInTheDocument()
          if (mode === 'ADAPT') expect(within(receipt).getByText('Reviewed rename')).toBeInTheDocument()
          const terms = within(receipt).getAllByRole('term').map(term => term.textContent)
          const values = within(receipt).getAllByRole('definition').map(definition => definition.textContent)
          const policy = locale === 'en' ? 'Rules policy' : 'Política de reglas'
          expect(terms[0]).toBe(policy)
          expect(values).toEqual(['authoring-experience-v1',
            ...(mode === 'REUSE' || mode === 'ADAPT' ? ['saved-workflow', 'v3 · immutable-version-3'] : []),
            ...(mode === 'ADAPT' ? ['Reviewed rename'] : []),
          ])
          expect(terms).toHaveLength(values.length)

          if (mode === 'ESCALATE') expect(screen.getByRole('button', { name: copy[locale].apply })).toBeDisabled()
          expect(props.onApplyWorkflowProposal).not.toHaveBeenCalled()
          expect(useWorkflowStore.getState().currentWorkflowId).toBe('current')
        })
      }
      it(`${locale} requires a new explicit preview for the only permitted name edit`, async () => {
        await changeAppLanguage(locale)
        const onProposeWorkflow = vi.fn<AiStudioPanelProps['onProposeWorkflow']>(async (_brief, _version, _prompt, edits) =>
          edits?.length ? response('ADAPT', edits[0].value) : response('REUSE'))
        const { props } = renderPanel({ onProposeWorkflow })
        await propose(locale)
        const originalCalls = onProposeWorkflow.mock.calls.length
        fireEvent.change(screen.getByLabelText(copy[locale].name), { target: { value: '  Explicit reviewed name  ' } })
        expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
        expect(screen.getByRole('button', { name: copy[locale].apply })).toBeDisabled()
        expect(onProposeWorkflow).toHaveBeenCalledTimes(originalCalls)
        fireEvent.click(screen.getByRole('button', { name: copy[locale].build }))
        await screen.findByTestId('experience-review')
        expect(onProposeWorkflow).toHaveBeenLastCalledWith(compilation.brief, catalog.version, expect.any(String), [{ field: 'workflow_name', value: 'Explicit reviewed name' }])
        expect(within(screen.getByTestId('experience-review')).getByText('Explicit reviewed name')).toBeInTheDocument()
        expect(props.onApplyWorkflowProposal).not.toHaveBeenCalled()
      })
      it(`${locale} enforces the 200 UTF-8 byte limit before sending a name preview`, async () => {
        await changeAppLanguage(locale)
        const { props } = renderPanel()
        await propose(locale)
        fireEvent.change(screen.getByLabelText(copy[locale].name), { target: { value: '😀'.repeat(51) } })
        expect(screen.getByRole('button', { name: copy[locale].build })).toBeDisabled()
        expect(props.onProposeWorkflow).toHaveBeenCalledOnce()
        fireEvent.change(screen.getByLabelText(copy[locale].name), { target: { value: '😀'.repeat(50) } })
        expect(screen.getByRole('button', { name: copy[locale].build })).toBeEnabled()
      })
      it(`${locale} pending Apply retains its snapshot while contextual prefill waits for focus`, async () => {
        await changeAppLanguage(locale)
        const pending = deferred<{ status: 'applied' }>()
        const onApplyWorkflowProposal = vi.fn<AiStudioPanelProps['onApplyWorkflowProposal']>(() => pending.promise)
        const { props, rerender } = renderPanel({ onApplyWorkflowProposal })
        await propose(locale)
        const reviewed = response('REUSE')
        fireEvent.click(screen.getByRole('button', { name: copy[locale].apply }))
        expect(screen.getByLabelText(copy[locale].name)).toBeDisabled()
        rerender(<AiStudioPanel {...props} actionRequest={{ id: 41, action: 'generate', prompt: 'New prepared intent' }} />)
        const input = screen.getByLabelText(locale === 'en' ? 'Business intent' : 'Intención de negocio')
        expect(input).toBeDisabled()
        expect(input).toHaveValue('New prepared intent')
        expect(onApplyWorkflowProposal).toHaveBeenCalledExactlyOnceWith(reviewed)
        await act(async () => pending.resolve({ status: 'applied' }))
        expect(input).toBeEnabled()
        expect(document.activeElement).toBe(input)
        expect(props.onProposeWorkflow).toHaveBeenCalledOnce()
        expect(props.onCompileWorkflowBrief).toHaveBeenCalledOnce()
        expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
      })
      for (const outcome of ['resolve', 'reject'] as const) {
        it(`${locale} name edit discards late preview ${outcome} without releasing a newer request`, async () => {
          await changeAppLanguage(locale)
          const first = deferred<ReturnType<typeof response>>()
          const next = deferred<ReturnType<typeof response>>()
          const onProposeWorkflow = vi.fn<AiStudioPanelProps['onProposeWorkflow']>().mockResolvedValueOnce(response('REUSE')).mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise)
          renderPanel({ onProposeWorkflow })
          await propose(locale)
          fireEvent.change(screen.getByLabelText(copy[locale].name), { target: { value: 'Old name' } })
          fireEvent.click(screen.getByRole('button', { name: copy[locale].build }))
          fireEvent.change(screen.getByLabelText(copy[locale].name), { target: { value: 'Current name' } })
          fireEvent.click(screen.getByRole('button', { name: copy[locale].build }))
          await act(async () => { if (outcome === 'resolve') first.resolve(response('ADAPT', 'Old name')); else first.reject(new Error('STALE_PREVIEW_ERROR')) })
          expect(screen.queryByText('STALE_PREVIEW_ERROR')).not.toBeInTheDocument()
          expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
          expect(screen.getByLabelText(locale === 'en' ? 'Business intent' : 'Intención de negocio')).toBeDisabled()
          await act(async () => { next.resolve(response('ADAPT', 'Current name')) })
          await screen.findByTestId('experience-review')
          expect(screen.getByLabelText(copy[locale].name)).toHaveValue('Current name')
          expect(screen.getByLabelText(locale === 'en' ? 'Business intent' : 'Intención de negocio')).toBeEnabled()
          expect(onProposeWorkflow).toHaveBeenCalledTimes(3)
        })
      }
    }
  })
}
