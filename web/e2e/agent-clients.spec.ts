import { expect, test, type Page } from '@playwright/test'
import { execPostgresSql } from './_helpers/postgres'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'

type Role = 'admin' | 'editor' | 'peer' | 'viewer'

function users(stamp: string): Record<Role, string> {
  return { admin: `ac-admin-${stamp}`, editor: `ac-editor-${stamp}`, peer: `ac-peer-${stamp}`, viewer: `ac-viewer-${stamp}` }
}

/** Opens Settings > Access as one member: every browser call carries their id. */
async function openAccessAs(page: Page, orgId: string, userId: string) {
  await page.addInitScript((activeOrg) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
  }, orgId)
  await page.route('**/*', async (route) => {
    const headers = route.request().headers()
    if (!headers['x-user-id']) return route.continue()
    return route.continue({ headers: { ...headers, 'x-user-id': userId } })
  })
  await page.goto('/#/operations/access')
  await expect(page.getByTestId('agent-clients-panel')).toBeVisible({ timeout: 30_000 })
}

test.describe('agent clients by role', () => {
  test('the screen offers only what the API allows each role, shows the token once, and an admin revokes', async ({ browser, request }) => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const orgId = `agent-clients-${stamp}`
    const member = users(stamp)
    await execPostgresSql(`INSERT INTO org_members (id, org_id, user_id, role) VALUES
      ('m-${member.admin}', '${orgId}', '${member.admin}', 'admin'),
      ('m-${member.editor}', '${orgId}', '${member.editor}', 'editor'),
      ('m-${member.peer}', '${orgId}', '${member.peer}', 'editor'),
      ('m-${member.viewer}', '${orgId}', '${member.viewer}', 'viewer')`)
    const as = (role: Role) => ({ 'Content-Type': 'application/json', 'x-org-id': orgId, 'x-user-id': member[role], 'x-janusly-csrf': '1' })

    // The editor creates one; the token appears once and leaves the DOM on close.
    const editor = await browser.newPage()
    await openAccessAs(editor, orgId, member.editor)
    await editor.getByTestId('agent-client-new').click()
    const create = editor.getByTestId('agent-client-create-dialog')
    await create.getByLabel(/^Name/).fill('Claude Code e2e')
    await create.getByLabel(/Test/).check()
    await create.getByTestId('agent-client-create-submit').click()
    const tokenDialog = editor.getByTestId('agent-token-dialog')
    await expect(tokenDialog).toBeVisible()
    const token = await tokenDialog.getByTestId('agent-token-value').inputValue()
    expect(token).toMatch(/^jly_agent_/)
    await expect(tokenDialog).toContainText(`claude mcp add --transport http janusly`)
    await tokenDialog.getByTestId('agent-token-done').click()
    await expect(tokenDialog.getByTestId('agent-token-confirm')).toBeVisible()
    await tokenDialog.getByTestId('agent-token-close').click()
    await expect(editor.getByTestId('agent-token-dialog')).toHaveCount(0)
    expect(await editor.content()).not.toContain(token)
    const leaked = await editor.evaluate((value) => JSON.stringify({ ...localStorage }).includes(value)
      || JSON.stringify({ ...sessionStorage }).includes(value), token)
    expect(leaked).toBe(false)
    const row = editor.locator('[data-testid^="agent-client-"][data-state]').filter({ hasText: 'Claude Code e2e' })
    await expect(row).toBeVisible()
    await expect(row.getByRole('button', { name: 'Rotate the token for Claude Code e2e' })).toBeVisible()
    await editor.close()

    const listed = await request.get(`${API_URL}/v1/agent-clients`, { headers: as('peer') })
    const clientId = ((await listed.json()).data.clients as Array<{ id: string; name: string }>)
      .find((client) => client.name === 'Claude Code e2e')?.id
    expect(clientId).toBeTruthy()

    // A viewer sees the row but is offered no way to create or change it, and the API agrees.
    const viewer = await browser.newPage()
    await openAccessAs(viewer, orgId, member.viewer)
    await expect(viewer.getByTestId(`agent-client-${clientId}`)).toBeVisible()
    await expect(viewer.getByTestId('agent-client-new')).toHaveCount(0)
    await expect(viewer.getByTestId(`agent-client-${clientId}`).getByRole('button', { name: /Rotate|Revoke/ })).toHaveCount(0)
    const refused = await request.post(`${API_URL}/v1/agent-clients`, { headers: as('viewer'), data: { name: 'nope' } })
    expect(refused.status()).toBe(403)
    await viewer.close()

    // Another editor sees it but is not offered a rotation, and the API agrees.
    const peer = await browser.newPage()
    await openAccessAs(peer, orgId, member.peer)
    const peerRow = peer.getByTestId(`agent-client-${clientId}`)
    await expect(peerRow).toBeVisible()
    await expect(peerRow.getByRole('button', { name: /Rotate/ })).toHaveCount(0)
    await expect(peerRow.getByRole('button', { name: /Revoke/ })).toHaveCount(0)
    const rotated = await request.post(`${API_URL}/v1/agent-clients/${clientId}/rotate`, { headers: as('peer'), data: {} })
    expect(rotated.status()).toBe(403)
    expect((await rotated.json()).error.code).toBe('agent_client_not_owned')
    await peer.close()

    // An admin revokes someone else's client; the confirmation names what stops working.
    const admin = await browser.newPage()
    await openAccessAs(admin, orgId, member.admin)
    const adminRow = admin.getByTestId(`agent-client-${clientId}`)
    await expect(adminRow.getByRole('button', { name: /Rotate/ })).toHaveCount(0)
    await adminRow.getByRole('button', { name: 'Revoke Claude Code e2e' }).click()
    const confirm = admin.getByRole('alertdialog')
    await expect(confirm).toContainText(`ending in ${token.slice(-4)}`)
    await confirm.getByRole('button', { name: 'Revoke' }).click()
    await expect(admin.getByTestId(`agent-client-state-${clientId}`)).toHaveText('Revoked')
    await expect(adminRow).toHaveAttribute('data-dimmed', 'true')
    const after = await request.get(`${API_URL}/v1/agent-clients/${clientId}`, { headers: as('viewer') })
    expect((await after.json()).data.client.status).toBe('revoked')
    await admin.close()
  })
})
