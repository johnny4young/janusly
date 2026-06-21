import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Focused e2e for the workflow-list folder grouping. Seeds two workflows in
 * folder "A", one in folder "B", and one ungrouped via the live API
 * (dev-headers auth), then drives the Flows UI to verify: the list renders one
 * collapsible section per folder (with the right rows + count) plus an
 * "Ungrouped" section, and a collapsed section stays collapsed across a reload
 * (localStorage persistence).
 *
 * Folder names are stamped unique per run so the assertions are robust against a
 * shared dev DB that may already hold other workflows / folders.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const DEV_HEADERS = { 'Content-Type': 'application/json', 'x-org-id': 'default', 'x-user-id': 'dev-user' }

async function saveWorkflow(request: APIRequestContext, id: string, name: string): Promise<void> {
  const res = await request.post(`${API_URL}/workflows/save`, {
    headers: DEV_HEADERS,
    data: { id, name, nodes: [{ id: 'n1', type: 'noop' }], edges: [] },
  })
  if (!res.ok()) throw new Error(`save ${id} failed: ${res.status()} ${await res.text()}`)
}

async function setFolder(request: APIRequestContext, id: string, folder: string | null): Promise<void> {
  const res = await request.post(`${API_URL}/workflows/${id}/metadata`, {
    headers: DEV_HEADERS,
    data: { metadata: { owners: [], tags: [], folder } },
  })
  if (!res.ok()) throw new Error(`folder ${id} failed: ${res.status()} ${await res.text()}`)
}

test('Flows list groups by folder and persists a collapsed section across reload', async ({ page, request }) => {
  const stamp = Date.now()
  const alphaId = `e2e-fld-alpha-${stamp}`
  const betaId = `e2e-fld-beta-${stamp}`
  const gammaId = `e2e-fld-gamma-${stamp}`
  const deltaId = `e2e-fld-delta-${stamp}`
  const folderA = `e2e-A-${stamp}`
  const folderB = `e2e-B-${stamp}`

  await saveWorkflow(request, alphaId, `E2E Folder Alpha ${stamp}`)
  await saveWorkflow(request, betaId, `E2E Folder Beta ${stamp}`)
  await saveWorkflow(request, gammaId, `E2E Folder Gamma ${stamp}`)
  await saveWorkflow(request, deltaId, `E2E Folder Delta ${stamp}`)
  await setFolder(request, alphaId, folderA)
  await setFolder(request, betaId, folderA)
  await setFolder(request, gammaId, folderB)
  // deltaId stays ungrouped (no folder set).

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()
  await page.getByRole('button', { name: 'Flows' }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()

  const sectionA = page.locator(`[data-testid="workflows-folder-${folderA}"]`)
  const sectionB = page.locator(`[data-testid="workflows-folder-${folderB}"]`)
  const ungrouped = page.locator('[data-testid="workflows-folder-ungrouped"]')

  // Folder A holds alpha + beta and shows the "2 flows" count pill.
  await expect(sectionA).toBeVisible()
  await expect(sectionA.locator(`[data-testid="workflows-row-${alphaId}"]`)).toBeVisible()
  await expect(sectionA.locator(`[data-testid="workflows-row-${betaId}"]`)).toBeVisible()
  await expect(sectionA.getByText('2 flows')).toBeVisible()

  // Folder B holds gamma; delta lands in the Ungrouped section.
  await expect(sectionB.locator(`[data-testid="workflows-row-${gammaId}"]`)).toBeVisible()
  await expect(ungrouped.locator(`[data-testid="workflows-row-${deltaId}"]`)).toBeVisible()

  // Collapse folder A → its rows hide.
  await sectionA.locator('summary').click()
  await expect(sectionA.locator(`[data-testid="workflows-row-${alphaId}"]`)).toBeHidden()

  // Reload → navigate back to Flows → folder A is still collapsed (persisted).
  await page.reload()
  await expect(page.getByText('dev-user')).toBeVisible()
  await page.getByRole('button', { name: 'Flows' }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(sectionA).toBeVisible()
  await expect(sectionA.locator(`[data-testid="workflows-row-${alphaId}"]`)).toBeHidden()
  // Folder B (never collapsed) stays open.
  await expect(sectionB.locator(`[data-testid="workflows-row-${gammaId}"]`)).toBeVisible()
})
