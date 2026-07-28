import { mkdir } from 'node:fs/promises'
import { expect, test, type Locator, type Page } from '@playwright/test'

const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

type LocaleContract = {
  locale: 'en' | 'es'
  newFlow: string
  workflowName: string
  dialogTitle: string
  confirm: string
  cancel: string
}

const LOCALES: LocaleContract[] = [
  {
    locale: 'en',
    newFlow: 'New',
    workflowName: 'Name',
    dialogTitle: 'Unsaved changes',
    confirm: 'Discard changes',
    cancel: 'Cancel',
  },
  {
    locale: 'es',
    newFlow: 'Nuevo',
    workflowName: 'Nombre',
    dialogTitle: 'Cambios sin guardar',
    confirm: 'Descartar cambios',
    cancel: 'Cancelar',
  },
]

function installConsoleErrorGuards(page: Page): string[] {
  const errors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('pageerror', (error) => errors.push(error.message))
  return errors
}

async function hideUnrelatedOverlays(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const selector of ['.toast', '.we-onboarding-banner', '.we-budget-banner', '[data-testid="command-palette"]']) {
      for (const element of document.querySelectorAll<HTMLElement>(selector)) element.style.display = 'none'
    }
  })
}

async function captureDialog(dialog: Locator, name: string): Promise<void> {
  await expect(dialog).toBeVisible()
  if (!EVIDENCE_DIR) return
  await mkdir(EVIDENCE_DIR, { recursive: true })
  await dialog.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` })
}

test.describe.configure({ mode: 'serial' })

for (const contract of LOCALES) {
  test(`${contract.locale} confirm dialog owns focus, wraps Tab, and restores the trigger`, async ({ page }) => {
    const browserErrors = installConsoleErrorGuards(page)
    const orgId = `confirm-focus-${contract.locale}-${Date.now()}`
    await page.addInitScript(({ activeOrg, locale }) => {
      window.localStorage.setItem('janusly:activeOrg', activeOrg)
      window.localStorage.setItem('janusly:locale', locale)
    }, { activeOrg: orgId, locale: contract.locale })

    await page.goto('/')
    await expect(page.getByText('dev-user')).toBeVisible()
    await page.getByRole('button', {
      name: /^AI Studio\b/,
    }).click()

    const newFlowTrigger = page.getByRole('button', { name: contract.newFlow, exact: true })
    await newFlowTrigger.click()
    const workflowName = page.getByRole('textbox', { name: contract.workflowName, exact: true })
    const dirtyName = `Focus contract ${contract.locale} ${Date.now()}`
    await workflowName.fill(dirtyName)
    await newFlowTrigger.click()

    const dialog = page.getByRole('alertdialog')
    const confirmButton = dialog.getByRole('button', { name: contract.confirm, exact: true })
    const cancelButton = dialog.getByRole('button', { name: contract.cancel, exact: true })
    await expect(dialog.getByRole('heading', { name: contract.dialogTitle, exact: true })).toBeVisible()
    await expect(confirmButton).toBeFocused()
    await hideUnrelatedOverlays(page)
    await captureDialog(dialog, `web-${contract.locale}-confirm-dialog-initial-focus`)

    await page.keyboard.press('Tab')
    await expect(cancelButton).toBeFocused()
    await captureDialog(dialog, `web-${contract.locale}-confirm-dialog-tab-wrap`)
    await page.keyboard.press('Shift+Tab')
    await expect(confirmButton).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(newFlowTrigger).toBeFocused()
    await expect(workflowName).toHaveValue(dirtyName)
    expect(browserErrors).toEqual([])
  })
}
