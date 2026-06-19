import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Focused e2e for the workflow-list tag filter. Seeds two tagged
 * workflows via the live API (dev-headers auth, the demo-helpers pattern), then
 * drives the Flows UI to verify: tag filter narrows the list (lista), a name
 * search within a tag filter shows the no-match state (no matches), and "All
 * tags" + cleared search restores the full list (clear filter).
 *
 * Note: the tag-specific empty state (`workflows-no-tag-matches`) is defensive
 * and not cleanly reachable here — metadata requires an existing workflow and a
 * workflow delete cascades its metadata, so every dropdown tag always matches
 * ≥1 workflow. The reachable "no matches" surface under a filter is the list's
 * `workflows-no-matches` (name search yields nothing), which this exercises.
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

async function tagWorkflow(request: APIRequestContext, id: string, tags: string[]): Promise<void> {
  const res = await request.post(`${API_URL}/workflows/${id}/metadata`, {
    headers: DEV_HEADERS,
    data: { metadata: { owners: [], tags } },
  })
  if (!res.ok()) throw new Error(`tag ${id} failed: ${res.status()} ${await res.text()}`)
}

test('Flows list filters by tag, shows the no-match state, and clears the filter', async ({ page, request }) => {
  const stamp = Date.now()
  const alphaId = `e2e-tags-alpha-${stamp}`
  const betaId = `e2e-tags-beta-${stamp}`
  const alphaTag = `e2e-alpha-${stamp}`
  const betaTag = `e2e-beta-${stamp}`

  await saveWorkflow(request, alphaId, `E2E Tags Alpha ${stamp}`)
  await saveWorkflow(request, betaId, `E2E Tags Beta ${stamp}`)
  await tagWorkflow(request, alphaId, [alphaTag])
  await tagWorkflow(request, betaId, [betaTag])

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()
  await page.getByRole('button', { name: 'Flows' }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()

  const alphaRow = page.locator(`[data-testid="workflows-row-${alphaId}"]`)
  const betaRow = page.locator(`[data-testid="workflows-row-${betaId}"]`)
  await expect(alphaRow).toBeVisible()
  await expect(betaRow).toBeVisible()

  // The alpha row renders its tag pill.
  await expect(alphaRow.getByText(alphaTag)).toBeVisible()

  // lista: filter by the alpha tag (server-side) → only alpha remains.
  await page.getByTestId('workflows-tag-filter').selectOption(alphaTag)
  await expect(alphaRow).toBeVisible()
  await expect(betaRow).toHaveCount(0)

  // no matches: with the tag filter active, a name search matching nothing
  // surfaces the list's no-match state.
  await page.getByTestId('workflows-search').fill(`zzz-no-match-${stamp}`)
  await expect(page.getByTestId('workflows-no-matches')).toBeVisible()
  await expect(alphaRow).toHaveCount(0)

  // clear filter: clear the search + select "All tags" → both rows return.
  await page.getByTestId('workflows-search').fill('')
  await page.getByTestId('workflows-tag-filter').selectOption('')
  await expect(alphaRow).toBeVisible()
  await expect(betaRow).toBeVisible()
})
