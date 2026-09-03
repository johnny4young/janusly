import { expect, test, type APIRequestContext } from '@playwright/test'

/**
 * Focused e2e for the workflow-list multi-tag filter. Seeds two tagged
 * workflows via the live API (dev-headers auth, the demo-helpers pattern), then
 * drives the Flows UI to verify: adding one tag narrows the list, adding a
 * second tag ANDs the filter into the tag-specific empty state, removing a chip
 * widens back to one tag, and clearing the final chip restores the full list.
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
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()

  const alphaRow = page.locator(`[data-testid="workflows-row-${alphaId}"]`)
  const betaRow = page.locator(`[data-testid="workflows-row-${betaId}"]`)
  await expect(alphaRow).toBeVisible()
  await expect(betaRow).toBeVisible()

  // The alpha row renders its tag pill.
  await expect(alphaRow.getByText(alphaTag)).toBeVisible()

  // Filter by the alpha tag (server-side) → only alpha remains.
  await page.getByTestId('workflows-tag-filter-add').selectOption(alphaTag)
  await expect(page.getByTestId(`workflows-tag-filter-remove-${alphaTag}`)).toBeVisible()
  await expect(alphaRow).toBeVisible()
  await expect(betaRow).toHaveCount(0)

  // Add beta too: the query becomes alpha AND beta, so neither one-tag row
  // matches and the tag-specific empty state is reachable.
  await page.getByTestId('workflows-tag-filter-add').selectOption(betaTag)
  await expect(page.getByTestId(`workflows-tag-filter-remove-${betaTag}`)).toBeVisible()
  await expect(page.getByTestId('workflows-no-tag-matches')).toBeVisible()
  await expect(alphaRow).toHaveCount(0)
  await expect(betaRow).toHaveCount(0)

  // Remove beta: the filter widens back to alpha-only.
  await page.getByTestId(`workflows-tag-filter-remove-${betaTag}`).click()
  await expect(alphaRow).toBeVisible()
  await expect(betaRow).toHaveCount(0)

  // no matches: with the alpha filter active, a name search matching nothing
  // surfaces the list's search no-match state.
  await page.getByTestId('workflows-search').fill(`zzz-no-match-${stamp}`)
  await expect(page.getByTestId('workflows-no-matches')).toBeVisible()
  await expect(alphaRow).toHaveCount(0)

  // clear filter: clear the search + remove the last tag chip → both rows return.
  await page.getByTestId('workflows-search').fill('')
  await page.getByTestId(`workflows-tag-filter-remove-${alphaTag}`).click()
  await expect(alphaRow).toBeVisible()
  await expect(betaRow).toBeVisible()
})
