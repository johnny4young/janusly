import { act, render, screen } from '@testing-library/react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { initI18n } from '../i18n'
import { useWorkflowStore } from '../store'
import { VersionHistoryPanel } from './VersionHistoryPanel'

vi.mock('../api', () => {
  const api = vi.fn()
  return { api, contractApi: (_op: string, path: string, _body: unknown, options?: RequestInit) => api(path, options) }
})
const initialState = useWorkflowStore.getState()

beforeEach(() => {
  useWorkflowStore.setState({ ...initialState, currentWorkflowId: 'history', currentWorkflowSaved: true, workflowDirty: false, toasts: [] }, true)
  useWorkflowStore.setState({ identityContext: {
    identity: { userId: 'dev-user', email: null, mode: 'dev-headers', source: 'dev' },
    profile: { name: null, email: null },
    organizations: [{ id: 'default', name: 'Default', plan: null, role: 'editor', roleBase: 'editor',
      permissions: ['workflows.read', 'workflows.write'], usable: true, developmentFallback: false, isOwner: false }],
    invitations: [], currentOrganizationId: 'default', selectionRequired: false, needsOrganization: false,
    truncated: false, invitationsTruncated: false,
  } })
  vi.mocked(api).mockReset()
})

describe('Version history in Chromium', () => {
  it('keeps suggestion choices and dismissal usable with shared buttons at mobile width', async () => {
    const context = useWorkflowStore.getState().identityContext!
    useWorkflowStore.setState({ identityContext: { ...context,
      organizations: context.organizations.map(org => ({ ...org, permissions: [...org.permissions, 'ai.write'] })),
    } })
    const workflow = { id: 'history', name: 'History', nodes: [], edges: [] }
    vi.mocked(api).mockImplementation(async path => path.startsWith('/workflows/versions')
      ? [2, 1].map(version => ({ workflowId: 'history', id: `snapshot-${version}`, version, createdAt: null, dagJson: workflow }))
      : { mode: 'ai', suggestions: [
        { workflow: { ...workflow, name: 'First proposal' }, rationale: 'FIRST rationale', approachLabel: 'add_retry', confidence: 0.8 },
        { workflow: { ...workflow, name: 'Second proposal' }, rationale: 'SECOND rationale', approachLabel: 'raise_timeout', confidence: 0.9 },
      ] })
    await page.viewport(390, 844)
    const view = render(<VersionHistoryPanel />)
    try {
      await userEvent.click(await screen.findByRole('button', { name: 'Compare' }))
      await userEvent.click(screen.getByRole('button', { name: /^v2/ }))
      await userEvent.click(screen.getByRole('button', { name: /^v1$/ }))
      await userEvent.click(screen.getByRole('button', { name: 'Suggest improvement' }))
      await expect.element(page.getByRole('button', { name: 'Add retry · 80%' })).toHaveAttribute('aria-pressed', 'true')
      const alternative = screen.getByRole('button', { name: 'Raise timeout · 90%' })
      screen.getByRole('button', { name: 'Add retry · 80%' }).focus()
      await userEvent.keyboard('{Tab}')
      expect(alternative).toHaveFocus()
      await userEvent.keyboard('{Enter}')
      expect(alternative).toHaveAttribute('aria-pressed', 'true')
      expect(screen.getByText('SECOND rationale')).toBeVisible()
      expect(alternative.getBoundingClientRect().height).toBeGreaterThanOrEqual(28)
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
      const dismiss = screen.getByRole('button', { name: 'Dismiss AI suggestions' })
      expect(dismiss.getBoundingClientRect().width).toBeGreaterThanOrEqual(32)
      await page.getByRole('group', { name: 'Suggested improvement angles' }).screenshot({ path: '../../test-results/history-suggestion-controls-390.png' })
      await userEvent.click(dismiss)
      expect(screen.queryByRole('group', { name: 'Suggested improvement angles' })).not.toBeInTheDocument()
      expect(useWorkflowStore.getState().currentWorkflowVersion).toBeNull()
    } finally { view.unmount(); await page.viewport(1024, 768) }
  })

  it.each([
    { locale: 'en', retry: 'Retry', compare: 'Compare', cancel: 'Cancel', error: 'Version history failed to load' },
    { locale: 'es', retry: 'Reintentar', compare: 'Comparar', cancel: 'Cancelar', error: 'No se pudo cargar el historial de versiones' },
  ] as const)('retries by keyboard and loads the exact immutable version in $locale', async ({ locale, retry, compare, cancel, error }) => {
    initI18n(locale)
    let reject: (reason: Error) => void = () => { throw new Error('not requested') }
    vi.mocked(api).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    await page.viewport(390, 844)
    const view = render(<VersionHistoryPanel />)
    try {
      expect(screen.getByRole('status')).toBeVisible()
      expect(screen.queryByTestId('version-history-empty')).not.toBeInTheDocument()
      await act(async () => reject(new Error('offline')))
      await expect.element(page.getByRole('alert')).toHaveTextContent(error)
      expect(screen.queryByTestId('version-history-empty')).not.toBeInTheDocument()
      vi.mocked(api).mockResolvedValue([2, 1].map(version => ({
        workflowId: 'history', id: `snapshot-${version}`, version, createdAt: null,
        dagJson: { id: 'history', name: `History ${version}`, nodes: [], edges: [] },
      })))
      screen.getByRole('button', { name: retry }).focus()
      await userEvent.keyboard('{Enter}')
      await expect.element(page.getByRole('button', { name: compare, exact: true })).toBeVisible()
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
      const rollback = document.querySelector<HTMLButtonElement>('.version-row__rollback')!
      expect(rollback.getBoundingClientRect().width).toBeGreaterThanOrEqual(32)
      expect(rollback).toHaveAccessibleName()
      await userEvent.click(screen.getByRole('button', { name: compare }))
      await userEvent.click(screen.getByRole('button', { name: /^v2/ }))
      await userEvent.click(screen.getByRole('button', { name: /^v1$/ }))
      expect(screen.getByRole('button', { name: /^v1$/ })).toHaveAttribute('aria-pressed', 'true')
      await userEvent.click(screen.getByRole('button', { name: cancel }))
      screen.getByRole('button', { name: /^v1$/ }).focus()
      await userEvent.keyboard('{Enter}')
      expect(useWorkflowStore.getState().currentWorkflowVersion).toEqual({ id: 'snapshot-1', version: 1 })
      expect(useWorkflowStore.getState().currentWorkflowName).toBe('History 1')
      expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    } finally {
      view.unmount()
      await page.viewport(1024, 768)
    }
  })
})
