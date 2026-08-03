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
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
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

  // Reload immediately, without waiting for a React effect: the native toggle
  // handler itself must have persisted the collapse before it returned.
  await page.reload()
  await expect.poll(() => page.evaluate(() => {
    const raw = window.localStorage.getItem('janusly:flowsFilters')
    return raw ? (JSON.parse(raw) as { collapsedFolders?: string[] }).collapsedFolders ?? [] : []
  })).toContain(folderA)
  await expect(page.getByText('dev-user')).toBeVisible()
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await expect(sectionA).toHaveJSProperty('open', false)
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(sectionA).toBeVisible()
  await expect(sectionA.locator(`[data-testid="workflows-row-${alphaId}"]`)).toBeHidden()
  // Folder B (never collapsed) stays open.
  await expect(sectionB.locator(`[data-testid="workflows-row-${gammaId}"]`)).toBeVisible()
})

test('Flows list folder filter narrows the list server-side and clears back to all', async ({ page, request }) => {
  const stamp = Date.now()
  const aId = `e2e-ff-a-${stamp}`
  const bId = `e2e-ff-b-${stamp}`
  const folderA = `e2e-ff-A-${stamp}`
  const folderB = `e2e-ff-B-${stamp}`

  await saveWorkflow(request, aId, `E2E FF Alpha ${stamp}`)
  await saveWorkflow(request, bId, `E2E FF Beta ${stamp}`)
  await setFolder(request, aId, folderA)
  await setFolder(request, bId, folderB)

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()

  const aRow = page.locator(`[data-testid="workflows-row-${aId}"]`)
  const bRow = page.locator(`[data-testid="workflows-row-${bId}"]`)
  await expect(aRow).toBeVisible()
  await expect(bRow).toBeVisible()

  // Filter to folder A (server-side) → only A's workflow remains.
  await page.getByTestId('workflows-folder-filter').selectOption(folderA)
  await expect(aRow).toBeVisible()
  await expect(bRow).toHaveCount(0)

  // Clear back to "All folders" → both return.
  await page.getByTestId('workflows-folder-filter').selectOption('')
  await expect(aRow).toBeVisible()
  await expect(bRow).toBeVisible()
})

test('Flows list drag-to-folder reassigns a workflow by dropping its row on a folder section', async ({ page, request }) => {
  const stamp = Date.now()
  const aId = `e2e-dnd-a-${stamp}`
  const bId = `e2e-dnd-b-${stamp}`
  const folderA = `e2e-dnd-A-${stamp}`
  const folderB = `e2e-dnd-B-${stamp}`

  await saveWorkflow(request, aId, `E2E DnD Alpha ${stamp}`)
  await saveWorkflow(request, bId, `E2E DnD Beta ${stamp}`)
  await setFolder(request, aId, folderA)
  await setFolder(request, bId, folderB)

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()

  const sectionA = page.locator(`[data-testid="workflows-folder-${folderA}"]`)
  const sectionB = page.locator(`[data-testid="workflows-folder-${folderB}"]`)
  const handleB = page.locator(`[data-testid="workflows-drag-${bId}"]`)

  // bId starts in folder B; its drag handle is rendered (folders exist).
  await expect(sectionB.locator(`[data-testid="workflows-row-${bId}"]`)).toBeVisible()
  await expect(handleB).toBeVisible()

  // Native HTML5 drag-drop: share ONE DataTransfer across the dispatched events
  // (Playwright's reliable pattern — dragstart's setData persists into drop's getData).
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer())
  const folderWrite = page.waitForResponse(response => {
    const request = response.request()
    return request.method() === 'POST'
      && new URL(response.url()).pathname === `/workflows/${bId}/folder`
  })
  await handleB.dispatchEvent('dragstart', { dataTransfer })
  await sectionA.dispatchEvent('dragover', { dataTransfer })
  await sectionA.dispatchEvent('drop', { dataTransfer })
  expect((await folderWrite).ok()).toBe(true)

  // The row moves into folder A (optimistic, then confirmed by the refetch).
  await expect(sectionA.locator(`[data-testid="workflows-row-${bId}"]`)).toBeVisible()
  await expect(sectionB.locator(`[data-testid="workflows-row-${bId}"]`)).toHaveCount(0)

  // The move persisted through the narrow folder route.
  const res = await request.get(`${API_URL}/workflows/${bId}/metadata`, { headers: DEV_HEADERS })
  expect(((await res.json()) as { metadata: { folder: string } }).metadata.folder).toBe(folderA)
})
