import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

/**
 * Flows table: labelled columns and header sorting. Seeds three flows through
 * the live API, including one whose failed run leaves an open dead letter, and
 * drives the sort with the keyboard only.
 */

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const DEV_HEADERS = { 'Content-Type': 'application/json', 'x-org-id': 'default', 'x-user-id': 'dev-user' }

function failingDoc(id: string, name: string) {
  return {
    id,
    name,
    nodes: [{ id: 'call', type: 'http', config: { url: 'http://127.0.0.1:9/unreachable', timeoutMs: 500 } }],
    edges: [],
  }
}

async function post(request: APIRequestContext, path: string, data: unknown) {
  const res = await request.post(`${API_URL}${path}`, { headers: DEV_HEADERS, data })
  if (!res.ok()) throw new Error(`${path} failed: ${res.status()} ${await res.text()}`)
  return res.json()
}

async function rowOrder(page: Page, stamp: number) {
  const rows = page.locator(`[data-testid^="workflows-row-e2e-table-"][data-testid$="-${stamp}"]`)
  return rows.evaluateAll(nodes => nodes.map(node => (node.getAttribute('data-testid') ?? '').split('-')[4]))
}

test('labels each number and sorts from the header by keyboard', async ({ page, request }) => {
  const stamp = Date.now()
  const id = (name: string) => `e2e-table-${name}-${stamp}`
  await post(request, '/workflows/save', { id: id('alpha'), name: `Table alpha ${stamp}`, nodes: [{ id: 'n1', type: 'noop' }], edges: [] })
  await post(request, '/workflows/save', { id: id('zulu'), name: `Table zulu ${stamp}`, nodes: [{ id: 'n1', type: 'noop' }], edges: [] })
  const failing = failingDoc(id('mike'), `Table mike ${stamp}`)
  await post(request, '/workflows/save', failing)
  const started = await post(request, '/start', { workflow: failing })
  const runId: string = started.runId
  await expect.poll(async () => {
    const res = await request.get(`${API_URL}/run?runId=${encodeURIComponent(runId)}`, { headers: DEV_HEADERS })
    return (await res.json()).run?.status
  }, { timeout: 30_000 }).toBe('failed')

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()
  await page.getByRole('button', { name: 'Workflows', exact: true }).click()
  await page.getByTestId('workflows-search').fill(String(stamp))

  const failingRow = page.getByTestId(`workflows-row-${id('mike')}`)
  await expect(failingRow).toBeVisible()
  const table = page.getByRole('table', { name: 'Saved flows' })
  for (const column of ['Name', 'Status', 'Open failures', 'Health', 'Last run', 'Version']) {
    await expect(table.getByRole('columnheader', { name: column, exact: true })).toBeVisible()
  }
  await expect(page.getByTestId(`workflows-open-failures-${id('mike')}`)).toHaveText('1')
  await expect(page.getByTestId(`workflows-open-failures-${id('alpha')}`)).toHaveText('0')
  await expect(page.getByTestId(`workflows-version-${id('mike')}`)).toHaveText('v1')
  await expect(page.getByTestId(`workflows-last-run-${id('mike')}`).locator('time')).toBeVisible()
  await expect(page.getByTestId(`workflows-last-run-${id('alpha')}`)).toHaveText('Never')
  await expect(failingRow.getByRole('button', { name: 'Open flow' })).toBeVisible()
  await page.getByTestId(`workflows-delete-${id('mike')}`).click()
  const confirmText = failingRow.getByText(`Delete "Table mike ${stamp}"?`)
  await expect(confirmText).toBeVisible()
  expect((await confirmText.boundingBox())?.width).toBeGreaterThan(40)
  const cancel = failingRow.getByRole('button', { name: 'Cancel' })
  const rowBox = await failingRow.boundingBox()
  const cancelBox = await cancel.boundingBox()
  expect((cancelBox?.x ?? Infinity) + (cancelBox?.width ?? 0)).toBeLessThanOrEqual((rowBox?.x ?? 0) + (rowBox?.width ?? 0))
  await cancel.click()
  await expect(page.getByTestId(`workflows-delete-${id('mike')}`)).toBeVisible()

  const nameHeader = table.getByRole('columnheader', { name: 'Name', exact: true })
  const failuresHeader = table.getByRole('columnheader', { name: 'Open failures', exact: true })

  await page.getByTestId('workflows-sort-name').focus()
  await page.keyboard.press('Enter')
  await expect(nameHeader).toHaveAttribute('aria-sort', 'ascending')
  await expect.poll(() => rowOrder(page, stamp)).toEqual(['alpha', 'mike', 'zulu'])
  await page.keyboard.press('Space')
  await expect(nameHeader).toHaveAttribute('aria-sort', 'descending')
  await expect.poll(() => rowOrder(page, stamp)).toEqual(['zulu', 'mike', 'alpha'])

  await page.keyboard.press('Tab')
  await expect(page.getByTestId('workflows-sort-status')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('workflows-sort-openFailures')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(failuresHeader).toHaveAttribute('aria-sort', 'descending')
  await expect(nameHeader).toHaveAttribute('aria-sort', 'none')
  await expect.poll(async () => (await rowOrder(page, stamp))[0]).toBe('mike')

  await page.reload()
  await expect(page.getByRole('table', { name: 'Saved flows' }).getByRole('columnheader', { name: 'Open failures', exact: true }))
    .toHaveAttribute('aria-sort', 'descending')
})
