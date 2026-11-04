import { expect, test, type Page } from '@playwright/test'
import { seedCredential } from './_helpers/demo-helpers'
import { openWorkspaceSection } from './_helpers/workspace-navigation'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'

async function openConnections(page: Page, orgId: string) {
  await page.addInitScript((activeOrg) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
  }, orgId)
  await page.goto('/')
  await openWorkspaceSection(page, 'Settings', 'Connections')
}

test('Rotate and Revoke read the real blast radius, and Revoke needs the typed name', async ({ page, request }) => {
  const browserErrors: string[] = []
  page.on('pageerror', (error) => browserErrors.push(error.message))
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const orgId = `credential-revoke-${stamp}`
  const usedName = `e2e-used-${stamp}`
  const unusedName = `e2e-unused-${stamp}`
  const workflowName = `Uses the credential ${stamp}`
  const headers = { 'Content-Type': 'application/json', 'x-org-id': orgId, 'x-user-id': 'dev-user' }

  await seedCredential(request, { name: usedName, kind: 'generic', secretRef: 'E2E_REVOKE_USED_SECRET' }, orgId)
  await seedCredential(request, { name: unusedName, kind: 'generic', secretRef: 'E2E_REVOKE_UNUSED_SECRET' }, orgId)
  const saved = await request.post(`${API_URL}/workflows/save`, {
    headers,
    data: {
      id: `wf-revoke-${stamp}`,
      name: workflowName,
      dslVersion: '1.0',
      nodes: [{
        id: 'call',
        type: 'tool',
        config: { tool: 'text.uppercase', credential: usedName, input: { value: 'x' } },
      }],
      edges: [],
    },
  })
  expect(saved.ok()).toBe(true)

  await openConnections(page, orgId)
  const usedRow = page.getByTestId('connections-table').getByRole('row').filter({ hasText: usedName })
  await expect(usedRow).toBeVisible()
  await expect(usedRow.getByTestId('connections-used-by')).toHaveText('1 workflow')

  await usedRow.getByRole('button', { name: 'Rotate secret', exact: true }).click()
  const rotate = page.getByRole('dialog')
  await expect(rotate.getByRole('heading', { name: 'Affected workflows (1)' })).toBeVisible()
  await expect(rotate.getByRole('listitem')).toHaveText(workflowName)
  await page.keyboard.press('Escape')
  await expect(rotate).toHaveCount(0)

  await usedRow.getByRole('button', { name: 'Revoke', exact: true }).click()
  const revoke = page.getByRole('alertdialog')
  await expect(revoke.getByRole('heading', { name: 'Affected workflows (1)' })).toBeVisible()
  await expect(revoke.getByRole('listitem')).toHaveText(workflowName)
  const typedName = revoke.getByTestId('credential-revoke-typed-name')
  await expect(typedName).toBeFocused()
  const confirm = revoke.getByTestId('credential-revoke-confirm')
  await expect(confirm).toBeDisabled()
  await typedName.fill(usedName.toUpperCase())
  await page.keyboard.press('Enter')
  await expect(revoke).toBeVisible()
  await typedName.fill(usedName)
  await expect(confirm).toBeEnabled()
  await confirm.click()
  await expect(revoke).toHaveCount(0)
  await expect(usedRow).toHaveCount(0)

  const health = await request.get(`${API_URL}/credentials/health`, { headers })
  const names = ((await health.json()) as { credentials: { name: string }[] }).credentials.map((entry) => entry.name)
  expect(names).toEqual([unusedName])

  const unusedRow = page.getByTestId('connections-table').getByRole('row').filter({ hasText: unusedName })
  await unusedRow.getByRole('button', { name: 'Revoke', exact: true }).click()
  const plainRevoke = page.getByRole('alertdialog')
  await expect(plainRevoke.getByRole('heading', { name: 'Affected workflows (0)' })).toBeVisible()
  await expect(plainRevoke.getByTestId('credential-revoke-typed-name')).toHaveCount(0)
  await expect(plainRevoke.getByTestId('credential-revoke-cancel')).toBeFocused()
  await plainRevoke.getByTestId('credential-revoke-confirm').click()
  await expect(unusedRow).toHaveCount(0)

  expect(browserErrors).toEqual([])
})
