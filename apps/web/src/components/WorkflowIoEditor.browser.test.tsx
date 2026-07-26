/**
 * Real-Chromium smoke for editing a declared input's default.
 *
 * jsdom already covers the state round-trip; what needs a real browser is the
 * part jsdom fakes: the decimal keyboard hint and in-progress text must coexist
 * with a normalized JSON number in application state (a string default fails
 * `input_default_type_mismatch` at save).
 */

import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { WorkflowDefinition } from '../types'
import { WorkflowIoEditor } from './WorkflowIoEditor'

function Harness({ initialInputs }: { initialInputs: WorkflowDefinition['inputs'] }) {
  const [inputs, setInputs] = useState(initialInputs)
  return (
    <>
      <WorkflowIoEditor
        workflowId="workflow-a"
        inputs={inputs}
        outputs={undefined}
        templatePolicy={undefined}
        onChangeInputs={setInputs}
        onChangeOutputs={() => {}}
        onChangeTemplatePolicy={() => {}}
      />
      <output data-testid="io-state">{JSON.stringify(inputs)}</output>
    </>
  )
}

describe('<WorkflowIoEditor /> defaults (browser smoke)', () => {
  it('renders the default control next to its field and keeps number typing', () => {
    render(<Harness initialInputs={{
      type: 'object',
      properties: {
        timeZone: { type: 'string', description: 'IANA zone', default: 'Europe/Madrid' },
        snoozeHours: { type: 'number' },
      },
      required: ['timeZone'],
    }} />)

    // The declared default is visible in the row it belongs to, not in a
    // separate surface the operator has to hunt for.
    const timeZoneRow = screen.getByTestId('workflow-input-timeZone')
    const timeZoneDefault = screen.getByLabelText('Default value for timeZone') as HTMLInputElement
    expect(timeZoneRow.contains(timeZoneDefault)).toBe(true)
    expect(timeZoneDefault.value).toBe('Europe/Madrid')

    const snooze = screen.getByLabelText('Default value for snoozeHours') as HTMLInputElement
    expect(snooze.inputMode).toBe('decimal')

    fireEvent.change(snooze, { target: { value: '12' } })
    const stored = JSON.parse(screen.getByTestId('io-state').textContent ?? '{}')
    expect(stored.properties.snoozeHours.default).toBe(12)
    expect(typeof stored.properties.snoozeHours.default).toBe('number')
  })

  it('lays the default control out inside the visible row', () => {
    render(<Harness initialInputs={{
      type: 'object',
      properties: { timeZone: { type: 'string', default: 'UTC' } },
    }} />)

    const row = screen.getByTestId('workflow-input-timeZone')
    const control = screen.getByLabelText('Default value for timeZone')
    const rowBox = row.getBoundingClientRect()
    const controlBox = control.getBoundingClientRect()

    // Real layout: the control has size and sits within its row's bounds.
    expect(controlBox.width).toBeGreaterThan(0)
    expect(controlBox.height).toBeGreaterThan(0)
    expect(controlBox.top).toBeGreaterThanOrEqual(rowBox.top - 1)
    expect(controlBox.bottom).toBeLessThanOrEqual(rowBox.bottom + 1)
  })
})
