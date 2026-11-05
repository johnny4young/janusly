import { render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { changeAppLanguage } from '../i18n'
import { AuthoringPanel, type AuthoringPanelModel } from './AuthoringPanel'

vi.mock('./InspectorPanel', () => ({ InspectorPanel: () => null }))
vi.mock('./WorkflowOperationsPanel', () => ({ WorkflowOperationsPanel: () => null }))

const model = {
  selectedNode: null,
  selectedEdge: null,
  validationIssues: [],
  aiReviewIssues: [],
  readinessResult: null,
  workflowEdges: [],
} as unknown as AuthoringPanelModel

afterEach(() => changeAppLanguage('en'))

describe('<AuthoringPanel /> AI toolbar (browser)', () => {
  // 287 and 327 are the panel's inner width at its minimum and maximum columns.
  it.each([
    ['en', 287],
    ['en', 327],
    ['es', 287],
    ['es', 327],
  ] as const)('keeps every %s label whole on one line at %i px', async (locale, width) => {
    await changeAppLanguage(locale)
    render(
      <div style={{ width }}>
        <AuthoringPanel model={model} canWrite canUseAi onOpenAiAction={vi.fn()} />
      </div>,
    )

    const toolbar = screen.getByTestId('authoring-ai-toolbar')
    const buttons = within(toolbar).getAllByRole('button')
    expect(buttons).toHaveLength(4)
    const tops = new Set(buttons.map((button) => button.getBoundingClientRect().top))
    expect(tops.size).toBe(1)
    expect(toolbar.scrollWidth).toBeLessThanOrEqual(toolbar.clientWidth)
    for (const button of buttons) {
      expect(button.scrollWidth, button.textContent ?? '').toBeLessThanOrEqual(button.clientWidth)
    }
  })
})
