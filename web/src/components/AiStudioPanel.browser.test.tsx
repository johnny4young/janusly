/**
 * Real-Chromium coverage for AI Studio provider guidance and authoring status.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AuthoringCapabilityCatalog,
  ReviewFindings,
  WorkflowBriefCompilation,
  WorkflowProposalResponse,
} from '../types'
import { initI18n } from '../i18n'
import { AiStudioPanel } from './AiStudioPanel'

function parseRgb(value: string): [number, number, number] {
  const channels = value.match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number)
  if (!channels || channels.length !== 3) throw new Error('Expected an RGB color, received ' + value)
  return channels as [number, number, number]
}

function relativeLuminance(color: string): number {
  const [red, green, blue] = parseRgb(color)
  const convert = (channel: number) => {
    const normalized = channel / 255
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }
  return (0.2126 * convert(red))
    + (0.7152 * convert(green))
    + (0.0722 * convert(blue))
}

function contrastRatio(foreground: string, background: string): number {
  const values = [relativeLuminance(foreground), relativeLuminance(background)]
    .sort((left, right) => right - left)
  return (values[0]! + 0.05) / (values[1]! + 0.05)
}

const catalog = {
  schemaVersion: '1',
  version: 'browser-catalog',
  builtinTools: [],
  mcpTools: [],
  triggers: [{ id: 'manual', requiredConfig: [] }],
  credentials: [],
  subworkflows: [],
  primitives: [],
  warnings: [],
} as AuthoringCapabilityCatalog

const compilation: WorkflowBriefCompilation = {
  mode: 'deterministic',
  complete: true,
  clarifyingQuestions: [],
  brief: {
    version: '1',
    objective: 'Check an order',
    trigger: 'manual',
    inputs: [],
    expectedOutcome: 'Order checked',
    externalEffects: [],
    approvals: [],
    failurePolicy: 'stop',
    examples: [],
    language: 'en',
  },
}

function proposal(): WorkflowProposalResponse {
  return {
    mode: 'ai',
    brief: compilation.brief,
    clarifyingQuestions: [],
    bindings: {
      catalogVersion: catalog.version,
      resolved: [],
      missing: [],
      complete: true,
    },
    proposal: {
      workflow: { id: 'sample', name: 'Budget-aware workflow', nodes: [], edges: [] },
      intentContract: {},
      recoveryContract: null,
      qualification: { intent: false, recovery: false, semantic: false },
      assumptions: [],
      risks: [],
      readiness: { status: 'pass', issues: [] },
      diff: { nodesAdded: [], nodesRemoved: [], nodesChanged: [], edgesBefore: 0, edgesAfter: 0 },
      applicable: true,
    },
  }
}

function panelProps(overrides: Partial<Parameters<typeof AiStudioPanel>[0]> = {}): Parameters<typeof AiStudioPanel>[0] {
  return {
    health: null,
    workflowName: 'Sample workflow',
    onLoadAuthoringCapabilities: vi.fn(async () => catalog),
    onCompileWorkflowBrief: vi.fn(async () => compilation),
    onProposeWorkflow: vi.fn(async () => proposal()),
    onApplyWorkflowProposal: vi.fn(async () => true),
    onExplainWorkflow: vi.fn(async () => ({ mode: 'fallback' as const, explanation: '' })),
    onReviewWorkflow: vi.fn(async () => ({
      mode: 'fallback' as const,
      review: { status: 'pass', issues: [] } as ReviewFindings,
    })),
    actionRequest: null,
    onSuggestWorkflowImprovement: vi.fn(async () => ({ mode: 'fallback' as const, suggestions: [] })),
    onApplyWorkflowImprovement: vi.fn(async () => true),
    onOpenRuns: vi.fn(),
    onOpenTemplates: vi.fn(),
    ...overrides,
  }
}

describe('<AiStudioPanel /> provider guidance (browser)', () => {
  afterEach(() => {
    initI18n('en')
  })

  it('renders visible Anthropic guidance in English local mode', async () => {
    render(<AiStudioPanel {...panelProps()} />)

    const detail = await screen.findByText(/Configure ANTHROPIC_API_KEY for the API and worker/i)
    expect(detail.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(detail).display).not.toBe('none')
    expect(screen.getByText('Root .env has ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.queryByText(/OPENAI_API_KEY/i)).not.toBeInTheDocument()
  })

  it('renders visible Anthropic guidance in Spanish local mode', async () => {
    initI18n('es')
    render(<AiStudioPanel {...panelProps()} />)

    const detail = await screen.findByText(/Configura ANTHROPIC_API_KEY para la API y el worker/i)
    expect(detail.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(detail).display).not.toBe('none')
    expect(screen.getByText('El archivo .env de la raíz contiene ANTHROPIC_API_KEY')).toBeInTheDocument()
    expect(screen.queryByText(/OPENAI_API_KEY/i)).not.toBeInTheDocument()
  })

  it('renders visible Best-of-N backoff with accessible AI status contrast', async () => {
    const backedOff = proposal()
    backedOff.bonBackoff = { from: 4, to: 1 }
    render(
      <AiStudioPanel
        {...panelProps({
          health: {
            enabled: true,
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
            timeoutMs: 30_000,
            maxRetries: 0,
          },
          onProposeWorkflow: vi.fn(async () => backedOff),
        })}
      />,
    )

    await screen.findByTestId('capability-catalog-summary')
    fireEvent.click(screen.getByRole('button', { name: /Compile intent brief/i }))
    await screen.findByTestId('intent-brief')
    fireEvent.click(screen.getByRole('button', { name: /Build proposal/i }))

    const notice = await screen.findByTestId('ai-candidate-backoff')
    expect(notice.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(getComputedStyle(notice).display).not.toBe('none')
    expect(notice).toHaveTextContent('evaluated 1 of 4 candidates')

    const pill = document
      .querySelector<HTMLElement>('[data-testid="workflow-proposal"]')
      ?.closest('.ai-authoring-stage')
      ?.querySelector<HTMLElement>('.mode-pill-ai') ?? null
    expect(pill).not.toBeNull()
    const styles = getComputedStyle(pill!)
    expect(contrastRatio(styles.color, styles.backgroundColor)).toBeGreaterThanOrEqual(4.5)
  })
})
