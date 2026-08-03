import AxeBuilder from '@axe-core/playwright'
import { expect, type Page } from '@playwright/test'

const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']
const BLOCKING_IMPACTS = new Set(['serious', 'critical'])

type BlockingViolation = {
  context: string
  impact: string
  rule: string
  help: string
  nodes: Array<{
    target: string[]
    summary: string
  }>
}

export async function expectNoBlockingAccessibilityViolations(
  page: Page,
  context: string,
): Promise<void> {
  await page.locator('html').evaluate((root) => {
    for (const animation of root.getAnimations({ subtree: true })) {
      const endTime = animation.effect?.getComputedTiming().endTime
      if (typeof endTime === 'number' && Number.isFinite(endTime)) animation.finish()
    }
  })

  const results = await new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    .analyze()

  const violations: BlockingViolation[] = results.violations
    .filter((violation) => violation.impact && BLOCKING_IMPACTS.has(violation.impact))
    .map((violation) => ({
      context,
      impact: violation.impact ?? 'unknown',
      rule: violation.id,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target.map(String),
        summary: node.failureSummary ?? node.html,
      })),
    }))

  expect(violations, `${context} must have no serious or critical axe violations`).toEqual([])
}
