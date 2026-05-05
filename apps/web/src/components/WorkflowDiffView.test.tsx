import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorkflowDefinition } from '../types'
import { WorkflowDiffView } from './WorkflowDiffView'

function makeWorkflow(partial: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    dslVersion: '1.0',
    nodes: [],
    edges: [],
    ...partial,
  } as WorkflowDefinition
}

describe('<WorkflowDiffView />', () => {
  it('renders summary + a changed-node row with the expected severity tag', () => {
    const before = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://x' } }],
    })
    const after = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { url: 'https://x', retry: { maxAttempts: 3 } } }],
    })

    render(<WorkflowDiffView before={before} after={after} beforeLabel="v1" afterLabel="v2" />)

    // Summary line
    expect(screen.getByText(/v1/)).toBeInTheDocument()
    expect(screen.getByText(/v2/)).toBeInTheDocument()
    expect(screen.getByText(/1 node.*changed/i)).toBeInTheDocument()

    // Changed node row + retry tag
    expect(screen.getByText('fetch')).toBeInTheDocument()
    expect(screen.getByText('Retry')).toBeInTheDocument()
  })

  it('renders the empty-state when both sides are equal', () => {
    const wf = makeWorkflow({ nodes: [{ id: 'a', type: 'noop', config: {} }] })
    render(<WorkflowDiffView before={wf} after={wf} beforeLabel="v1" afterLabel="v1" />)
    expect(screen.getByText(/No structural changes/i)).toBeInTheDocument()
  })

  it('redacts before/after values for secret_ref-tagged changes', () => {
    const before = makeWorkflow({
      // Pre-template state had the literal value; this is exactly the
      // kind of leak the diff must NOT echo into the DOM.
      nodes: [{ id: 'fetch', type: 'http', config: { apiKey: 'literal-key-abc123' } }],
    })
    const after = makeWorkflow({
      nodes: [{ id: 'fetch', type: 'http', config: { apiKey: '{{secret.MY_KEY}}' } }],
    })
    render(<WorkflowDiffView before={before} after={after} />)
    expect(screen.queryByText(/literal-key-abc123/)).not.toBeInTheDocument()
    expect(screen.queryByText(/MY_KEY/)).not.toBeInTheDocument()
    expect(screen.getAllByText('[redacted]').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Secret-ref')).toBeInTheDocument()
  })

  it('renders the AI patch rationale when provided', () => {
    const before = makeWorkflow({
      nodes: [{ id: 'a', type: 'noop', config: {} }],
    })
    const after = makeWorkflow({
      nodes: [{ id: 'a', type: 'noop', config: {} }, { id: 'b', type: 'http', config: { url: 'https://x' } }],
    })
    render(
      <WorkflowDiffView
        before={before}
        after={after}
        aiPatchRationale="Adding a retry-aware HTTP node to recover from transient 5xx errors."
      />,
    )
    expect(screen.getByText(/Adding a retry-aware HTTP node/i)).toBeInTheDocument()
  })
})
