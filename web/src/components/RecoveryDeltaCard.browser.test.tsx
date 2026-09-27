import { act, render, screen } from '@testing-library/react'
import { page, userEvent } from 'vitest/browser'
import { beforeEach, expect, it, vi } from 'vitest'
import { api } from '../api'
import { initI18n } from '../i18n'
import { useWorkflowStore } from '../store'
import { RecoveryDeltaCard } from './RecoveryDeltaCard'

vi.mock('../api', async () => {
  const { contractApiOver } = await import('../test/contract-api-mock')
  const { healthDelta } = await import('../test/health-delta-fixture')
  const { patchResponse } = await import('../test/patch-response-fixture')
  const { runView, versionRows } = await import('../test/run-view-fixture')
  const api = vi.fn()
  // Typed calls reach the same path-keyed mock; partial fixtures are completed to the manifest.
  return {
    api,
    contractApi: contractApiOver(api, {
      'GET /run': runView,
      'GET /workflows/versions': versionRows,
      'GET /workflows/health/delta': healthDelta,
      'POST /ai/patch-workflow': (value: Record<string, unknown>) => patchResponse(value),
      'POST /recovery/playbooks/{id}/use': (value: { suggestion: Record<string, unknown> }) => ({ suggestion: patchResponse(value.suggestion) }),
    }),
  }
})
const initial = useWorkflowStore.getState()
const signals = { totalRuns: 5, p95LatencyMs: null, totalCostUsd: 0 }
const delta = { workflowId: 'workflow', afterVersion: 2, windowDays: 30, hasEnoughData: true, minRunsForDelta: 5,
  before: { score: 80, status: 'healthy', signals }, after: { score: 70, status: 'warn', signals },
  delta: { score: -10, p95LatencyMs: null, costPerRunUsd: 0 },
  recentRunsAgainstAfter: { totalRuns: 5, succeeded: 4, failed: 1, running: 0 },
  priorVersion: { version: 1, versionId: 'prior' }, sameFailureSinceApply: null,
}
beforeEach(() => {
  useWorkflowStore.setState({ ...initial, orgId: 'default', userId: 'dev-user', currentWorkflowId: 'workflow', identityContext: {
    identity: { userId: 'dev-user', email: null, mode: 'dev-headers', source: 'dev' }, profile: { name: null, email: null },
    organizations: [{ id: 'default', name: 'Default', plan: null, role: 'editor', roleBase: 'editor',
      permissions: ['workflows.read', 'workflows.write'], usable: true, developmentFallback: false, isOwner: false }],
    invitations: [], currentOrganizationId: 'default', selectionRequired: false, needsOrganization: false, truncated: false, invitationsTruncated: false,
  } }, true)
  vi.mocked(api).mockReset()
})
it.each([{ locale: 'en', retry: 'Retry', rollback: 'Roll back to v1', cancel: 'Cancel' },
  { locale: 'es', retry: 'Reintentar', rollback: 'Revertir a v1', cancel: 'Cancelar' }] as const)('owns health retry and keyboard rollback in $locale', async ({ locale, retry, rollback, cancel }) => {
  initI18n(locale)
  let malformed = true
  vi.mocked(api).mockImplementation(path => Promise.resolve(path.startsWith('/workflows/health/delta')
    ? { ...delta, workflowId: malformed ? 'foreign' : 'workflow' }
    : [{ workflowId: 'workflow', id: path.includes('version=1') ? 'prior' : 'current',
      version: path.includes('version=1') ? 1 : 2, createdAt: null,
      dagJson: { id: 'workflow', name: 'Recovery', nodes: [], edges: [] } }]))
  await page.viewport(390, 844)
  const view = render(<RecoveryDeltaCard workflowId="workflow" afterVersion={2} priorFailureSignature={null} preSaveBeforeSnapshot={null} />)
  try {
    await expect.element(page.getByRole('alert')).toBeVisible()
    expect(screen.queryByTestId('recovery-delta-counter')).not.toBeInTheDocument()
    malformed = false
    await userEvent.click(screen.getByRole('button', { name: retry }))
    await expect.element(page.getByRole('button', { name: rollback })).toBeVisible()
    await page.getByLabelText(locale === 'en' ? 'Recovery delta' : 'Delta de recuperación').screenshot({ path: `../../test-results/recovery-delta-${locale}-390.png` })
    await userEvent.click(screen.getByRole('button', { name: rollback }))
    await expect.element(page.getByRole('button', { name: cancel, exact: true })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: rollback })).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await expect.element(page.getByRole('dialog')).toBeVisible()
    await act(async () => { useWorkflowStore.setState({ userId: 'another' }) })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(vi.mocked(api).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
  } finally { view.unmount() }
})

it.each(['en', 'es'] as const)('exposes native completed-run progress in %s without counting in-flight runs', async locale => {
  initI18n(locale)
  vi.mocked(api).mockResolvedValue({ ...delta, hasEnoughData: false, delta: null,
    after: { ...delta.after, signals: { ...signals, totalRuns: 1 } },
    recentRunsAgainstAfter: { totalRuns: 6, succeeded: 1, failed: 0, running: 5 },
    sameFailureSinceApply: { count: 0, sampleDeadLetterIds: [], priorSignature: 'signature' },
  })
  await page.viewport(390, 844)
  const view = render(<RecoveryDeltaCard workflowId="workflow" afterVersion={2} priorFailureSignature="signature" preSaveBeforeSnapshot={null} />)
  try {
    await expect.element(page.getByRole('progressbar')).toBeVisible()
    const progress = screen.getByRole('progressbar') as HTMLProgressElement
    expect(progress.value).toBe(1)
    expect(progress.max).toBe(5)
    expect(progress.position).toBe(.2)
    await expect.element(page.getByRole('progressbar')).toHaveAccessibleName(locale === 'en'
      ? '1 of 5 completed runs from v2 — gathering comparison evidence.'
      : '1 de 5 ejecuciones terminadas desde v2 — reuniendo evidencia para comparar.')
    expect(screen.getByTestId('recovery-delta-same-failure').className).toContain('--neutral')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390)
    await page.getByLabelText(locale === 'en' ? 'Recovery delta' : 'Delta de recuperación').screenshot({ path: `../../test-results/recovery-delta-gathering-${locale}-390.png` })
  } finally { view.unmount() }
})
