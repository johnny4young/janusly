import { mkdir } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'

const API_URL = process.env.E2E_API_URL ?? 'http://localhost:3001'
const EVIDENCE_DIR = process.env.JANUSLY_EVIDENCE_DIR

async function expandStepPaletteGroup(page: Page, name: RegExp) {
  const group = page.getByRole('button', { name }).first()
  if ((await group.count()) === 0) return
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.click()
}

test('dev session can create, save, run, and reopen a workflow', async ({ page }) => {
  const workflowName = `E2E Noop ${Date.now()}`

  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill(workflowName)
  await expandStepPaletteGroup(page, /^Misc\b/)
  await page.getByRole('button', { name: /Do nothing/i }).click()

  await page.getByRole('button', { name: 'Validate', exact: true }).click()
  await expect(page.getByText('Flow is ready to run')).toBeVisible()

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/Saved version \d+/)).toBeVisible()

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/Run started:/)).toBeVisible()
  await page.getByRole('button', { name: /^AI Studio\b/ }).click()
  await expect(page.locator('.workflow-node').filter({ hasText: 'Do nothing' }).filter({ hasText: 'Done' })).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: 'Flows' }).click()
  await page.getByRole('button', { name: 'Refresh' }).click()
  await expect(page.locator('[data-testid^="workflows-row-"]').filter({ hasText: workflowName })).toBeVisible()
})

test('human form pauses a run, validates input, and resumes with submitted output', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('dev-user')).toBeVisible()

  await page.getByRole('button', { name: 'New', exact: true }).click()
  await page.getByRole('textbox', { name: 'Name' }).fill(`E2E Human Form ${Date.now()}`)
  await expandStepPaletteGroup(page, /^Human-in-the-loop\b/)
  await page.getByRole('button', { name: /Collect form/i }).click()

  await page.getByRole('button', { name: 'Validate', exact: true }).click()
  await expect(page.getByText('Flow is ready to run')).toBeVisible()

  await page.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByText(/Run started:/)).toBeVisible()
  await page.getByRole('button', { name: 'Runs', exact: true }).click()
  await expect(page.getByRole('button', { name: /Fill form/i })).toBeVisible({ timeout: 30_000 })

  await page.getByRole('button', { name: /Fill form/i }).click()
  await expect(page.getByRole('heading', { name: 'Collect request details' })).toBeVisible()
  await page.getByLabel('requester').fill('Ada')
  await page.getByLabel('reason').fill('PTO request')
  await page.getByRole('button', { name: /Submit form/i }).click()

  await expect(page.getByText(/Form .* submitted/)).toBeVisible()
  await page.getByRole('button', { name: /^AI Studio\b/ }).click()
  await expect(page.locator('.workflow-node').filter({ hasText: 'Done' })).toBeVisible({ timeout: 30_000 })
})

test('human form presents schema-valid initial values for operator review', async ({ page, request }) => {
  const stamp = Date.now()
  const orgId = 'default'
  const workflow = {
    dslVersion: '1.0',
    id: `support-review-${stamp}`,
    name: `Support review ${stamp}`,
    nodes: [{
      id: 'review',
      type: 'human_form',
      config: {
        title: 'Review drafted response',
        description: 'Confirm or edit the proposed response before delivery.',
        schema: {
          type: 'object',
          properties: {
            requester: { type: 'string', description: 'Customer name' },
            reason: { type: 'string', description: 'Proposed response' },
          },
          required: ['requester', 'reason'],
        },
        initialValues: {
          requester: 'Ada Lovelace',
          reason: 'I reviewed the account and prepared the next steps.',
        },
      },
    }],
    edges: [],
    outputs: { response: '{{context.review.output.reason}}' },
  }
  const headers = { 'Content-Type': 'application/json', 'x-org-id': orgId, 'x-user-id': 'dev-user' }
  const saved = await request.post(`${API_URL}/workflows/save`, {
    headers,
    data: workflow,
  })
  expect(saved.ok(), await saved.text()).toBe(true)
  const started = await request.post(`${API_URL}/start`, {
    headers,
    data: workflow,
  })
  const startedText = await started.text()
  expect(started.ok(), startedText).toBe(true)
  const startedBody = JSON.parse(startedText) as { runId?: unknown }
  expect(typeof startedBody.runId).toBe('string')

  await page.addInitScript(({ activeOrg }) => {
    window.localStorage.setItem('janusly:activeOrg', activeOrg)
    window.localStorage.setItem('janusly:locale', 'en')
  }, { activeOrg: orgId })
  await page.goto('/')
  await page.getByRole('button', { name: 'Flows', exact: true }).click()
  await page.getByTestId(`workflows-row-${workflow.id}`).click()
  await page.getByRole('button', { name: 'Runs', exact: true }).click()
  await page.getByRole('button', { name: `Open timeline for run ${startedBody.runId}` }).click()
  await expect(page.getByRole('button', { name: /Fill form/i })).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: /Fill form/i }).click()

  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('heading', { name: 'Review drafted response' })).toBeVisible()
  await expect(dialog.getByLabel('requester')).toHaveValue('Ada Lovelace')
  await expect(dialog.getByLabel('reason')).toHaveValue('I reviewed the account and prepared the next steps.')
  if (EVIDENCE_DIR) {
    await mkdir(EVIDENCE_DIR, { recursive: true })
    await dialog.screenshot({
      path: `${EVIDENCE_DIR}/human-form-prefilled-review.png`,
      animations: 'disabled',
      caret: 'hide',
    })
  }

  await dialog.getByLabel('reason').fill('Operator-approved response.')
  await dialog.getByRole('button', { name: /Submit form/i }).click()
  await expect(page.getByText(/Form .* submitted/)).toBeVisible()
})
