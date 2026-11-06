import { addCanvasStep, openWorkspaceSection } from './_helpers/workspace-navigation'
import { expect, test } from '@playwright/test'

test.use({ viewport: { width: 390, height: 844 } })

async function openMobileNavigation(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Navigation' }).click()
  await expect(page.locator('#workspace-sidebar')).toBeVisible()
}

test('mobile workspace remains usable without horizontal overflow', async ({ page }) => {
  await page.goto('/')

  await expect(page.locator('.we-recovery-center-hero')).toBeVisible()
  await openMobileNavigation(page)
  await expect(page.getByRole('button', { name: 'Home', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Workflows', exact: true })).toBeVisible()
  await expect(
    page.locator('#workspace-sidebar').getByRole('button', { name: 'Activity', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible()

  await openWorkspaceSection(page, 'Activity', 'Runs')
  await expect(page.getByRole('heading', { name: 'Runs', exact: true })).toBeVisible()
  await expect(page.getByTestId('activity-run-history')).toBeVisible()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})

test('mobile node setup can be reached from the canvas', async ({ page }) => {
  await page.goto('/')

  await openMobileNavigation(page)
  await openWorkspaceSection(page, 'Workflows', 'Build')
  // Onboarding is contextual to Recovery Center, so it cannot obscure this
  // canvas or its setup panel after navigation.
  await expect(page.getByTestId('onboarding-banner')).toHaveCount(0)
  await addCanvasStep(page, 'Call an API')

  await expect(page.getByRole('heading', { name: 'Build', exact: true })).toBeVisible()
  await expect(page.getByLabel('Request URL')).toBeVisible()
})

test('narrow desktop keeps contextual navigation readable without overflow', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 })
  await page.goto('/')

  await openWorkspaceSection(page, 'Settings', 'Connections')
  const sectionNav = page.getByTestId('workspace-section-nav')
  await expect(sectionNav).toHaveAttribute('data-destination', 'settings')
  await expect(sectionNav.getByRole('button', {
    name: 'Connections',
    exact: true,
  })).toHaveAttribute('aria-current', 'page')

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  expect(overflow).toBeLessThanOrEqual(2)
})

for (const locale of ['en', 'es'] as const) {
  test(`Build opens its panel on the inspector with the sections in the top bar (${locale})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.addInitScript((selectedLocale) => {
      window.localStorage.setItem('janusly:locale', selectedLocale)
    }, locale)
    await page.goto('/')

    const copy = locale === 'en'
      ? { workflows: 'Workflows', build: 'Build', all: 'All workflows' }
      : { workflows: 'Flujos', build: 'Crear', all: 'Todos los flujos' }
    await openWorkspaceSection(page, copy.workflows, copy.build)

    const topBar = page.locator('.top-bar')
    const sectionNav = page.getByTestId('workspace-section-nav')
    await expect(topBar.getByTestId('workspace-section-nav')).toBeVisible()
    await expect(sectionNav).toHaveCount(1)
    await expect(sectionNav.getByRole('button', { name: copy.build, exact: true }))
      .toHaveAttribute('aria-current', 'page')
    await expect.poll(async () => {
      const box = await sectionNav.boundingBox()
      const bar = await topBar.boundingBox()
      return box !== null && bar !== null && box.y + box.height <= bar.y + 56
    }).toBe(true)

    await page.getByTestId('top-bar-workflow-name').focus()
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('workspace-section-workflows')).toBeFocused()

    const panel = await page.locator('.workspace-panel').boundingBox()
    const scope = await page.locator('.authoring-scope-nav').boundingBox()
    const toolbar = page.getByTestId('authoring-ai-toolbar')
    const toolbarBox = await toolbar.boundingBox()
    expect(scope!.y - panel!.y).toBeLessThanOrEqual(20)
    expect(toolbarBox!.y + toolbarBox!.height - panel!.y).toBeLessThanOrEqual(110)
    for (const button of await toolbar.getByRole('button').all()) {
      expect(await button.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
    }

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(sectionNav).toBeVisible()
    expect(await topBar.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2)

    await sectionNav.getByRole('button', { name: copy.all, exact: true }).click()
    await expect(sectionNav).toBeVisible()
    await expect(topBar.getByTestId('workspace-section-nav')).toHaveCount(0)
  })
}

test('200% logical zoom keeps the recovery workspace navigable in both locales', async ({ browser }) => {
  // A 1280x720 desktop at 200% browser zoom exposes approximately 640x360
  // CSS pixels. Chromium's 2x device scale exercises the corresponding
  // rasterization, but this automated check is not a physical zoom pass.
  for (const locale of ['en', 'es'] as const) {
    const context = await browser.newContext({
      baseURL: test.info().project.use.baseURL,
      viewport: { width: 640, height: 360 },
      deviceScaleFactor: 2,
      reducedMotion: 'reduce',
    })
    try {
      const page = await context.newPage()
      await page.addInitScript(selectedLocale => {
        window.localStorage.setItem('janusly:locale', selectedLocale)
      }, locale)
      await page.goto('/')
      await expect(page.locator('.we-recovery-center-hero')).toBeVisible()

      const activity = locale === 'en' ? 'Activity' : 'Actividad'
      const runs = locale === 'en' ? 'Runs' : 'Ejecuciones'
      await openWorkspaceSection(page, activity, runs)
      await expect(page.getByTestId('activity-run-history')).toBeVisible()
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      )
      expect(overflow, `${locale} page overflow at 200% logical zoom`).toBeLessThanOrEqual(2)
    } finally {
      await context.close()
    }
  }
})
