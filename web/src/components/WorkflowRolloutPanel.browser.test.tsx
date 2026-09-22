import { act, render, screen, waitFor, within } from '@testing-library/react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api } from '../api'
import { initI18n } from '../i18n'
import { useWorkflowStore } from '../store'
import { ConfirmProvider } from './ConfirmDialog'
import { WorkflowRolloutPanel } from './WorkflowRolloutPanel'

vi.mock('../api', () => {
  const api = vi.fn()
  return { api, contractApi: (_op: string, path: string, _body: unknown, options?: RequestInit) => api(path, options) }
})

const initialState = useWorkflowStore.getState()
const versions = [2, 1].map(version => ({
  workflowId: 'workflow-1', id: `version-${version}`, version, createdAt: null,
  dagJson: { nodes: [], edges: [] },
}))

beforeEach(() => {
  useWorkflowStore.setState({ ...initialState, currentWorkflowId: 'workflow-1', currentWorkflowSaved: true, toasts: [] }, true)
  vi.mocked(api).mockReset()
})

describe('Rollout intent and form behavior in Chromium', () => {
  it.each([
    { locale: 'en', fields: ['Traffic share', 'Min. outcomes', 'Success floor'], start: 'Start canary', retry: 'Retry' },
    { locale: 'es', fields: ['Cuota de tráfico', 'Mín. de resultados', 'Umbral de éxito'], start: 'Iniciar canary', retry: 'Reintentar' },
  ] as const)('keeps bounded, labeled inputs and recovers from a context read failure in $locale', async ({ locale, fields, start, retry }) => {
    initI18n(locale)
    let unavailable = false
    vi.mocked(api).mockImplementation(async path => {
      if (unavailable) throw new Error('Unavailable')
      if (path.startsWith('/workflows/versions')) return versions
      if (path.includes('/rollout/qualification')) return { required: false, qualification: null }
      return { rollout: null }
    })
    await page.viewport(390, 844)
    const view = render(<WorkflowRolloutPanel />)
    try {
      await expect.element(page.getByRole('button', { name: start })).toBeEnabled()
      const panel = screen.getByTestId('workflow-rollout-panel')
      expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth + 1)
      for (const [index, label] of fields.entries()) {
        const input = screen.getByLabelText<HTMLInputElement>(label)
        expect(input).toHaveAttribute('min', index === 1 ? '5' : '1')
        expect(input).toHaveAttribute('max', index === 0 ? '50' : '100')
        expect(input.getBoundingClientRect().width).toBeGreaterThan(40)
        expect(input.getBoundingClientRect().right).toBeLessThanOrEqual(390)
        expect(input.labels).toHaveLength(1)
        await userEvent.fill(input, '101')
        expect(input.validity.rangeOverflow).toBe(true)
        await userEvent.fill(input, '10')
        expect(input.validity.valid).toBe(true)
      }
      await userEvent.click(screen.getByLabelText(fields[0]))
      await userEvent.keyboard('{Tab}')
      expect(screen.getByLabelText(fields[1])).toHaveFocus()
      await userEvent.keyboard('{Tab}')
      expect(screen.getByLabelText(fields[2])).toHaveFocus()
      const oldSignal = vi.mocked(api).mock.calls.find(([path]) => path.startsWith('/workflows/versions'))?.[1]?.signal
      unavailable = true
      act(() => useWorkflowStore.setState({ orgId: 'new-organization' }))
      const alert = await screen.findByRole('alert')
      expect(oldSignal?.aborted).toBe(true)
      expect(screen.queryByRole('button', { name: start })).not.toBeInTheDocument()
      unavailable = false
      const retryButton = within(alert).getByRole('button', { name: retry })
      retryButton.focus()
      await userEvent.keyboard('{Enter}')
      await expect.element(page.getByRole('button', { name: start })).toBeEnabled()
      expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
      await page.getByTestId('workflow-rollout-panel').screenshot({ path: `../../test-results/rollout-${locale}-390.png` })
    } finally {
      view.unmount()
      await page.viewport(1024, 768)
    }
  })

  it('does not send a confirmed rollback after identity changes while the dialog is open', async () => {
    vi.mocked(api).mockImplementation(async path => {
      if (path.startsWith('/workflows/versions')) return versions
      if (path.includes('/rollout/qualification')) return { required: false, qualification: null }
      return { rollout: {
        id: 'rollout-1', workflowId: 'workflow-1', baselineVersionId: 'version-1', canaryVersionId: 'version-2',
        trafficPercent: 10, minimumSampleSize: 10, minimumSuccessRatePercent: 90, status: 'active',
        baselineSucceeded: 8, baselineFailed: 0, canarySucceeded: 4, canaryFailed: 0,
        createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
      } }
    })
    render(<ConfirmProvider><WorkflowRolloutPanel /></ConfirmProvider>)
    await userEvent.click(await screen.findByRole('button', { name: 'Return to baseline' }))
    const dialog = screen.getByRole('alertdialog')
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus())
    act(() => useWorkflowStore.setState({ userId: 'new-operator' }))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Return to baseline' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(vi.mocked(api).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0)
    expect(useWorkflowStore.getState().toasts).toHaveLength(0)
  })
})
