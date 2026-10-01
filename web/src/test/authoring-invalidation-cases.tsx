import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AiStudioPanel } from '../components/AiStudioPanel'
import { changeAppLanguage } from '../i18n'
import { useWorkflowStore } from '../store'
import type { WorkflowBriefCompilation, WorkflowProposalApplyOutcome, WorkflowProposalResponse } from '../types'
import { catalog, compilation, workflowProposal } from './ai-studio-fixtures'
import { deferred } from './deferred'

const initialState = useWorkflowStore.getState()
const copy = {
  en: { input: 'Business intent', compile: 'Compile intent brief', propose: 'Build proposal', apply: 'Apply proposal to draft' },
  es: { input: 'Intención de negocio', compile: 'Compilar brief de intención', propose: 'Construir propuesta', apply: 'Aplicar propuesta al borrador' },
} as const

function testProps(): Parameters<typeof AiStudioPanel>[0] {
  return {
    health: null, workflowName: 'Local authoring', actionRequest: null,
    onLoadAuthoringCapabilities: vi.fn(async () => catalog),
    onCompileWorkflowBrief: vi.fn(async () => compilation),
    onProposeWorkflow: vi.fn(async () => workflowProposal()),
    onApplyWorkflowProposal: vi.fn(async () => ({ status: 'applied' as const })),
    onExplainWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, explanation: 'Local explanation' })),
    onReviewWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, review: { status: 'pass' as const, issues: [] } })),
    onSuggestWorkflowImprovement: vi.fn(async () => ({ mode: 'fallback' as const, suggestions: [] })),
    onApplyWorkflowImprovement: vi.fn(async () => true),
    onViewCanvas: vi.fn(), onOpenRuns: vi.fn(), onOpenTemplates: vi.fn(),
  }
}

export function registerAuthoringInvalidationCases() {
  describe('authoring request invalidation', () => {
    beforeEach(() => { useWorkflowStore.setState({ ...initialState, currentWorkflowId: 'wf_source' }, true) })
    for (const locale of ['en', 'es'] as const) {
      for (const stage of ['compile', 'propose'] as const) {
        for (const outcome of ['resolve', 'reject'] as const) {
          for (const startNew of [false, true]) {
            it(`${locale} ${stage} prefill discards late ${outcome}${startNew ? ' without clearing a newer request' : ' and releases loading'}`, async () => {
              await changeAppLanguage(locale)
              const props = testProps()
              const oldCompile = deferred<WorkflowBriefCompilation>()
              const oldProposal = deferred<WorkflowProposalResponse>()
              const nextCompile = deferred<WorkflowBriefCompilation>()
              const compile = vi.fn()
              if (stage === 'compile') compile.mockReturnValueOnce(oldCompile.promise)
              else compile.mockResolvedValueOnce(compilation)
              compile.mockReturnValueOnce(nextCompile.promise)
              props.onCompileWorkflowBrief = compile
              props.onProposeWorkflow = vi.fn(() => oldProposal.promise)
              const view = render(<AiStudioPanel {...props} />)
              await screen.findByTestId('capability-catalog-summary')
              fireEvent.click(screen.getByRole('button', { name: copy[locale].compile }))
              if (stage === 'propose') {
                await screen.findByTestId('intent-brief')
                fireEvent.click(screen.getByRole('button', { name: copy[locale].propose }))
                await waitFor(() => expect(props.onProposeWorkflow).toHaveBeenCalledOnce())
              }
              const nextPrompt = `Nuevo intent — ${locale} ${stage}`
              view.rerender(<AiStudioPanel {...props} actionRequest={{ id: 7, action: 'generate', prompt: nextPrompt }} />)
              const input = screen.getByLabelText(copy[locale].input)
              await waitFor(() => { expect(input).toHaveValue(nextPrompt); expect(input).toBeEnabled(); expect(input).toHaveFocus() })
              expect(screen.queryByTestId('intent-brief')).not.toBeInTheDocument()
              expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
              expect(compile).toHaveBeenCalledTimes(1)
              expect(props.onApplyWorkflowProposal).not.toHaveBeenCalled()
              if (startNew) {
                fireEvent.click(screen.getByRole('button', { name: copy[locale].compile }))
                await waitFor(() => expect(compile).toHaveBeenCalledTimes(2))
                expect(input).toBeDisabled()
              }
              await act(async () => {
                if (outcome === 'reject') {
                  if (stage === 'compile') oldCompile.reject(new Error('STALE_AUTHORING_ERROR'))
                  else oldProposal.reject(new Error('STALE_AUTHORING_ERROR'))
                } else if (stage === 'compile') oldCompile.resolve(compilation)
                else oldProposal.resolve(workflowProposal())
              })
              expect(screen.queryByText('STALE_AUTHORING_ERROR')).not.toBeInTheDocument()
              expect(screen.queryByTestId('workflow-proposal')).not.toBeInTheDocument()
              if (startNew) {
                expect(input).toBeDisabled()
                await act(async () => { nextCompile.resolve({ ...compilation, brief: { ...compilation.brief, objective: 'CURRENT_INTENT_ONLY' } }) })
                expect(await screen.findByTestId('intent-brief')).toHaveTextContent('CURRENT_INTENT_ONLY')
                expect(compile).toHaveBeenLastCalledWith(nextPrompt)
              }
              expect(input).toBeEnabled()
              expect(props.onApplyWorkflowProposal).not.toHaveBeenCalled()
              expect(props.onProposeWorkflow).toHaveBeenCalledTimes(stage === 'propose' ? 1 : 0)
            })
          }
        }
      }
      for (const boundary of ['workflow', 'identity'] as const) {
        it(`${locale} late compilation remains discarded after ${boundary} invalidation`, async () => {
          await changeAppLanguage(locale)
          const old = deferred<WorkflowBriefCompilation>()
          const props = testProps()
          props.onCompileWorkflowBrief = vi.fn(() => old.promise)
          render(<AiStudioPanel {...props} />)
          await screen.findByTestId('capability-catalog-summary')
          fireEvent.click(screen.getByRole('button', { name: copy[locale].compile }))
          act(() => { useWorkflowStore.setState(boundary === 'workflow' ? { currentWorkflowId: 'wf_new' } : { orgId: 'new-org', userId: 'new-user' }) })
          await act(async () => { old.resolve(compilation) })
          expect(screen.queryByTestId('intent-brief')).not.toBeInTheDocument()
          expect(screen.getByLabelText(copy[locale].input)).toBeEnabled()
          expect(props.onProposeWorkflow).not.toHaveBeenCalled()
          expect(props.onApplyWorkflowProposal).not.toHaveBeenCalled()
        })
      }
      it(`${locale} prefill preserves an in-flight Apply and defers focus until it settles`, async () => {
        await changeAppLanguage(locale)
        const pending = deferred<WorkflowProposalApplyOutcome>()
        const props = testProps()
        const proposalToApply = workflowProposal()
        const originalSnapshot = structuredClone(proposalToApply)
        props.onProposeWorkflow = vi.fn(async () => proposalToApply)
        props.onApplyWorkflowProposal = vi.fn(() => pending.promise)
        const view = render(<AiStudioPanel {...props} />)
        await screen.findByTestId('capability-catalog-summary')
        fireEvent.click(screen.getByRole('button', { name: copy[locale].compile }))
        await screen.findByTestId('intent-brief')
        fireEvent.click(screen.getByRole('button', { name: copy[locale].propose }))
        await screen.findByTestId('workflow-proposal')
        fireEvent.click(screen.getByRole('button', { name: copy[locale].apply }))
        await waitFor(() => expect(props.onApplyWorkflowProposal).toHaveBeenCalledOnce())
        view.rerender(<AiStudioPanel {...props} actionRequest={{ id: 8, action: 'generate', prompt: 'NEXT_INTENT_AFTER_APPLY' }} />)
        const input = screen.getByLabelText(copy[locale].input)
        await waitFor(() => expect(input).toHaveValue('NEXT_INTENT_AFTER_APPLY'))
        expect(input).toBeDisabled()
        expect(props.onApplyWorkflowProposal).toHaveBeenCalledTimes(1)
        expect(props.onCompileWorkflowBrief).toHaveBeenCalledTimes(1)
        expect(props.onApplyWorkflowProposal).toHaveBeenCalledWith(proposalToApply)
        expect(proposalToApply).toEqual(originalSnapshot)
        act(() => { useWorkflowStore.getState().hydrateWorkflow(proposalToApply.proposal.workflow, { saved: false, dirty: true }) })
        expect(input).toBeDisabled()
        await act(async () => { pending.resolve({ status: 'applied' }) })
        await waitFor(() => { expect(input).toBeEnabled(); expect(input).toHaveFocus() })
        expect(props.onApplyWorkflowProposal).toHaveBeenCalledTimes(1)
        expect(props.onCompileWorkflowBrief).toHaveBeenCalledTimes(1)
        expect(props.onApplyWorkflowProposal).toHaveBeenCalledWith(proposalToApply)
        expect(proposalToApply).toEqual(originalSnapshot)
      })
    }
  })
}
