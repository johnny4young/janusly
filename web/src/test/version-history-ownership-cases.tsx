import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, contractApi } from '../api'
import { changeAppLanguage } from '../i18n'
import { t } from '../i18n/runtime'
import { useWorkflowStore } from '../store'
import { VersionHistoryPanel } from '../components/VersionHistoryPanel'
import type { SessionContext } from '../identity-context'
import { deferred } from './deferred'

const initial = useWorkflowStore.getState()
const grants = ['workflows.read', 'workflows.write', 'ai.write']
function identity(permissions = grants): SessionContext {
  return {
    identity: { userId: 'operator', email: null, mode: 'dev-headers', source: 'dev' }, profile: { name: null, email: null },
    organizations: [{ id: 'tenant', name: 'Tenant', plan: null, role: 'editor', roleBase: 'editor', permissions,
      usable: true, developmentFallback: false, isOwner: false }], invitations: [], currentOrganizationId: 'tenant',
    selectionRequired: false, needsOrganization: false, truncated: false, invitationsTruncated: false,
  }
}
const rows = (version: number) => [{ id: `version-${version}`, version, workflowId: 'saved-source', createdAt: null,
  dagJson: { dslVersion: '1.0', id: 'saved-source', name: 'Exact saved example', nodes: [{ id: 'done', type: 'noop', config: {} }], edges: [] } }]

export function registerVersionHistoryOwnershipCases() {
  describe('saved-source history first-change ownership', () => {
    beforeAll(async () => { await import('../lib/authoring-contract') })
    beforeEach(() => {
      vi.mocked(api).mockReset()
      vi.mocked(contractApi).mockReset()
      useWorkflowStore.setState({ ...initial, orgId: 'tenant', userId: 'operator', identityContext: identity(),
        currentWorkflowId: 'saved-source', currentWorkflowSaved: true, activeTab: 'inspector', toasts: [] }, true)
      vi.mocked(api).mockResolvedValue({ config: [] })
    })
    for (const locale of ['en', 'es'] as const) {
      for (const boundary of ['organization', 'user', 'workflow', 'navigation', 'saved', ...grants]) {
        for (const outcome of ['resolve', 'reject'] as const) {
          for (const phase of ['initial', 'pagination', 'suggestion'] as const) {
            it(`${locale} old ${phase} ${outcome} cannot survive ${boundary} ABA or release a new page`, async () => {
              await changeAppLanguage(locale)
              const previous = deferred<unknown>()
              const next = deferred<unknown>()
              let reads = 0
              let retired: AbortSignal | undefined
              const pendingRead = phase === 'pagination' ? 2 : 1
              const expectedReads = phase === 'pagination' ? 3 : 2
              vi.mocked(api).mockImplementation(async (path, options) => {
                if (path !== '/ai/suggest-improvement') return { config: [] }
                retired = options?.signal ?? undefined
                return await previous.promise
              })
              vi.mocked(contractApi).mockImplementation(async (operation, _path, _body, options) => {
                if (operation !== 'GET /workflows/versions') throw new Error(`Unexpected operation: ${operation}`)
                reads += 1
                if (phase !== 'initial' && reads === 1) {
                  return (phase === 'pagination'
                    ? Array.from({ length: 50 }, (_, index) => rows(90 - index)[0])
                    : [...rows(7), ...rows(3)]) as never
                }
                if (phase !== 'suggestion' && reads === pendingRead) {
                  retired = options?.signal ?? undefined
                  return await previous.promise as never
                }
                return await next.promise as never
              })
              render(<VersionHistoryPanel />)
              if (phase === 'initial') await waitFor(() => expect(reads).toBe(1))
              else if (phase === 'pagination') {
                await screen.findByText('v90')
                fireEvent.click(screen.getByTestId('version-history-load-more'))
                await waitFor(() => expect(reads).toBe(2))
              } else {
                await screen.findByText('v7')
                fireEvent.click(screen.getByRole('button', { name: t('versionHistory.compare') }))
                fireEvent.click(screen.getByText('v7').closest('button')!)
                fireEvent.click(screen.getByText('v3').closest('button')!)
                fireEvent.click(screen.getByRole('button', { name: t('versionHistory.suggest') }))
                await waitFor(() => expect(retired).toBeDefined())
              }
              act(() => {
                const state = useWorkflowStore.getState()
                if (boundary === 'organization') useWorkflowStore.setState({ orgId: 'other' })
                else if (boundary === 'user') useWorkflowStore.setState({ userId: 'other' })
                else if (boundary === 'workflow') useWorkflowStore.setState({ currentWorkflowId: 'other' })
                else if (boundary === 'navigation') useWorkflowStore.setState({ activeTab: 'operations' })
                else if (boundary === 'saved') useWorkflowStore.setState({ currentWorkflowSaved: false })
                else useWorkflowStore.setState({ identityContext: identity(grants.filter(grant => grant !== boundary)) })
                useWorkflowStore.setState({ orgId: state.orgId, userId: state.userId, currentWorkflowId: state.currentWorkflowId,
                  activeTab: state.activeTab, currentWorkflowSaved: state.currentWorkflowSaved, identityContext: state.identityContext })
              })
              await act(async () => {
                if (outcome === 'resolve') previous.resolve(phase === 'suggestion' ? { mode: 'fallback', aiError: 'OLD history unavailable' } : rows(30))
                else previous.reject(new Error('OLD history unavailable'))
              })
              expect(screen.queryByText('v30')).not.toBeInTheDocument()
              expect(retired?.aborted).toBe(true)
              await waitFor(() => expect(reads).toBe(expectedReads))
              expect(screen.queryByText('OLD history unavailable')).not.toBeInTheDocument()
              expect(screen.getByRole('status')).toHaveTextContent(t('common.loading'))
              expect(useWorkflowStore.getState().toasts).toEqual([])
              await act(async () => next.resolve(rows(70)))
              await screen.findByText('v70')
              expect(screen.queryByText('v30')).not.toBeInTheDocument()
              expect(screen.queryByRole('status')).not.toBeInTheDocument()
              expect(useWorkflowStore.getState().workflowDirty).toBe(false)
              expect(useWorkflowStore.getState().currentWorkflowId).toBe('saved-source')
              expect(useWorkflowStore.getState().toasts).toEqual([])
            })
          }
        }
      }
    }
  })
}
