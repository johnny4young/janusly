import { openWorkspaceSection } from './_helpers/workspace-navigation'
import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { seedCredential } from './_helpers/demo-helpers'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

function installConsoleErrorGuards(page: Page) {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function captureDialog(page: Page, name: string): Promise<void> {
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await page.getByRole('dialog').screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

test('credential rotation owns focus, traps both Tab directions, and restores its trigger', async ({ page, request }) => {
  const browserErrors = installConsoleErrorGuards(page)
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const orgId = `credential-focus-${stamp}`
  const credentialName = `e2e-focus-${stamp}`
  await seedCredential(request, {
    name: credentialName,
    kind: 'generic',
    secretRef: 'E2E_ROTATION_FOCUS_SECRET',
  }, orgId)

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
  }, { activeOrg: orgId })

  await page.goto('/')
  await openWorkspaceSection(page, 'Settings', 'Connections')
  const credentialCard = page.locator('.list-card').filter({ hasText: credentialName })
  await expect(credentialCard).toBeVisible()
  const rotateTrigger = credentialCard.getByRole('button', { name: 'Rotate secret', exact: true })
  await rotateTrigger.click()

  const dialog = page.getByRole('dialog')
  await expect(dialog).toBeVisible()
  const closeButton = dialog.getByRole('button', { name: 'Close', exact: true })
  await expect(closeButton).toBeFocused()
  await expect(dialog.getByRole('heading', { name: 'Affected workflows (0)' })).toBeVisible()
  await captureDialog(page, 'web-en-credential-rotation-initial-focus')

  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(closeButton).toBeFocused()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(rotateTrigger).toBeFocused()
  expect(browserErrors).toEqual([])
})
