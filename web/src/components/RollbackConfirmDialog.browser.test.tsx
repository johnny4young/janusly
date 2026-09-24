import { useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '../api'
import { initI18n } from '../i18n'
import { useWorkflowStore } from '../store'
import { RollbackConfirmDialog } from './RollbackConfirmDialog'

vi.mock('../api', () => ({ api: vi.fn() }))
const initialState = useWorkflowStore.getState()

beforeEach(() => {
  useWorkflowStore.setState({ ...initialState, currentWorkflowId: 'rollback', currentWorkflowSaved: true, workflowDirty: true, toasts: [] }, true)
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


const workflow = { id: 'rollback', name: 'Rollback', nodes: [], edges: [] }
const current = { id: 'v2', version: 2, dagJson: workflow }
const target = { id: 'v1', version: 1, dagJson: workflow }
function Host() {
  const [open, setOpen] = useState(false)
  return <><button onClick={() => setOpen(true)}>Preview</button>
    {open && <RollbackConfirmDialog workflowId="rollback" current={current} target={target} onClose={() => setOpen(false)} />}</>
}

describe('Rollback confirmation in Chromium', () => {
  it.each(([
    { locale: 'en', cancel: 'Cancel', action: 'Roll back', close: 'Close', warning: /Replacing it discards them/ },
    { locale: 'es', cancel: 'Cancelar', action: 'Revertir', close: 'Cerrar', warning: /El lienzo tiene cambios/ },
  ] as const).flatMap(locale => (['success', 'malformed'] as const).map(outcome => ({ ...locale, outcome }))))('protects keyboard intent and immutable receipt in $locale / $outcome', async ({ locale, cancel, action, close, warning, outcome }) => {
    initI18n(locale)
    let finish: (value: unknown) => void = () => { throw new Error('not requested') }
    vi.mocked(api).mockImplementation(() => new Promise(resolve => { finish = resolve }))
    await page.viewport(390, 844)
    const view = render(<Host />)
    try {
      await userEvent.click(screen.getByRole('button', { name: 'Preview' }))
      await expect.element(page.getByRole('button', { name: cancel, exact: true })).toHaveFocus()
      await expect.element(page.getByText(warning)).toBeVisible()
      await userEvent.keyboard('{Enter}')
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
      expect(vi.mocked(api)).not.toHaveBeenCalled()
      await expect.element(page.getByRole('button', { name: 'Preview' })).toHaveFocus()
      await userEvent.keyboard('{Enter}')
      await expect.element(page.getByRole('button', { name: cancel, exact: true })).toHaveFocus()
      await page.getByRole('dialog').screenshot({ path: `../../test-results/rollback-${locale}-390.png` })
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
      await userEvent.keyboard('{Tab}')
      expect(screen.getByRole('button', { name: action })).toHaveFocus()
      await userEvent.keyboard('{Enter}')
      expect(vi.mocked(api)).toHaveBeenCalledTimes(1)
      await userEvent.keyboard('{Escape}')
      expect(screen.getByRole('dialog')).toBeVisible()
      expect(vi.mocked(api).mock.calls[0][1]?.signal?.aborted).toBe(false)
      await act(async () => finish({ workflowId: 'rollback', versionId: 'v3', version: 3, sourceVersion: outcome === 'success' ? 1 : 0 }))
      if (outcome === 'success') expect(useWorkflowStore.getState().currentWorkflowVersion).toEqual({ id: 'v3', version: 3 })
      else {
        await expect.element(page.getByRole('alert')).toBeVisible()
        expect(useWorkflowStore.getState().currentWorkflowVersion).toBeNull()
        await expect.element(page.getByRole('button', { name: close, exact: true })).toHaveFocus()
        await userEvent.keyboard('{Enter}')
      }
      await expect.element(page.getByRole('button', { name: 'Preview' })).toHaveFocus()
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    } finally { view.unmount(); await page.viewport(1024, 768) }
  })
})
