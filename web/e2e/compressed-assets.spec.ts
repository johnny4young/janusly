import { expect, test } from '@playwright/test'

// Only the executable serves precompressed assets; the Vite dev server does not.
test.skip(!process.env.JANUSLY_E2E_RUNTIME_BASE_URL, 'requires the built executable')

test('first Home load receives compressed text assets', async ({ page }) => {
  const origin = new URL(process.env.JANUSLY_E2E_RUNTIME_BASE_URL ?? '').origin
  const responses: { path: string, encoding: string, vary: string }[] = []
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin !== origin) return
    const headers = response.headers()
    responses.push({
      path: url.pathname,
      encoding: headers['content-encoding'] ?? '',
      vary: (headers['vary'] ?? '').toLowerCase(),
    })
  })

  await page.goto('/')
  await expect(page.locator('.we-recovery-center-hero')).toBeVisible()

  const document = responses.find((entry) => entry.path === '/')
  expect(document?.encoding).toBe('br')
  const text = responses.filter((entry) => /^\/assets\/.+\.(?:js|css)$/.test(entry.path))
  expect(text.length).toBeGreaterThan(2)
  for (const entry of text) {
    expect(entry, entry.path).toMatchObject({ encoding: 'br' })
    expect(entry.vary, entry.path).toContain('accept-encoding')
  }
  for (const entry of responses.filter((item) => item.path.endsWith('.woff2'))) {
    expect(entry.encoding, entry.path).toBe('')
  }

  const sizes = await page.evaluate(() => performance.getEntriesByType('resource')
    .concat(performance.getEntriesByType('navigation'))
    .filter((entry) => {
      const { pathname } = new URL(entry.name)
      return pathname === '/' || pathname.startsWith('/assets/')
    })
    .map((entry) => ({
      name: new URL(entry.name).pathname,
      encoded: (entry as PerformanceResourceTiming).encodedBodySize,
      decoded: (entry as PerformanceResourceTiming).decodedBodySize,
    })))
  const encoded = sizes.reduce((sum, entry) => sum + entry.encoded, 0)
  const decoded = sizes.reduce((sum, entry) => sum + entry.decoded, 0)
  test.info().annotations.push({
    type: 'home-static-transfer',
    description: `${(encoded / 1024).toFixed(1)} KiB encoded of ${(decoded / 1024).toFixed(1)} KiB decoded`,
  })
  expect(encoded).toBeLessThan(decoded * 0.5)
})
