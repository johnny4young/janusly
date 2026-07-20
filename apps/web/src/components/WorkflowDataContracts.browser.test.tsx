import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import type { WorkflowDefinition } from '../types'
import { ReasoningPanel } from './ReasoningPanel'
import { WorkflowIoEditor } from './WorkflowIoEditor'

function DataContractsFixture() {
  const [templatePolicy, setTemplatePolicy] = useState<WorkflowDefinition['templatePolicy']>()
  return (
    <div style={{ display: 'grid', gap: 24, width: 760, padding: 20 }}>
      <WorkflowIoEditor
        workflowId="browser-contracts"
        templatePolicy={templatePolicy}
        onChangeInputs={vi.fn()}
        onChangeOutputs={vi.fn()}
        onChangeTemplatePolicy={setTemplatePolicy}
      />
      <ReasoningPanel
        activeRunId="run-contracts"
        events={[{
          id: 'event-unresolved',
          type: 'template.unresolved_path',
          nodeId: 'notify',
          payload: {
            count: 2,
            paths: ['context.customer.output.email', 'inputs.subject'],
            truncated: false,
            policy: 'lenient',
          },
          createdAt: '2026-07-14T12:00:00.000Z',
        }]}
      />
    </div>
  )
}

describe('workflow data contracts (browser smoke)', () => {
  it('renders and toggles template policy beside a warning timeline event in Chromium', () => {
    render(<DataContractsFixture />)

    const policy = screen.getByTestId('workflow-template-policy')
    expect(policy.getBoundingClientRect().height).toBeGreaterThan(0)
    expect(within(policy).getByRole('status')).toHaveTextContent('Continue with an empty value')

    const strict = within(policy).getByRole('checkbox', { name: 'Fail on a missing value' })
    fireEvent.click(strict)
    expect(strict).toBeChecked()
    expect(within(policy).getByRole('status')).toHaveTextContent('Stop before using a missing value')

    const unresolved = screen.getByTestId('run-event-event-unresolved')
    expect(unresolved).toHaveAttribute('data-tone', 'warning')
    expect(unresolved).toHaveTextContent('Step notify found 2 unresolved template references')
    expect(unresolved.getBoundingClientRect().height).toBeGreaterThan(0)
  })
})
