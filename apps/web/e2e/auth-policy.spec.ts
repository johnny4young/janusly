import { expect, test } from '@playwright/test'

test('Operations auth policy panel validates and saves org settings', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Operations', exact: true }).click()
  await page.getByTestId('operations-rail-tab-access').click()

  await expect(page.getByRole('heading', { name: 'Authentication policies', exact: true })).toBeVisible()

  const domainInput = page
    .locator('label')
    .filter({ hasText: 'Allowed email domains' })
    .getByRole('textbox')
  const mfaToggle = page.getByRole('checkbox', { name: /Require multi-factor authentication/i })
  const ttlInput = page.getByRole('spinbutton', { name: /Session TTL/i })

  await expect(domainInput).toBeVisible()
  await expect(ttlInput).toHaveValue('28800')

  await ttlInput.fill('60')
  await expect(page.getByRole('alert')).toContainText('between 300 and 86400')
  await expect(page.getByRole('button', { name: /Save policies/i })).toBeDisabled()

  await domainInput.fill('acme.com, partner.com')
  await mfaToggle.check()
  await ttlInput.fill('1800')
  await page.getByRole('button', { name: /Save policies/i }).click()

  await expect(page.getByRole('button', { name: 'Authentication policies saved' })).toBeVisible()
  await expect(domainInput).toHaveValue('acme.com, partner.com')
  await expect(mfaToggle).toBeChecked()
  await expect(ttlInput).toHaveValue('1800')
})
