import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { initI18n } from '../i18n'
import type { JsonObject } from '../types'
import { HumanFormConfigEditor } from './TimingConfigEditors'

function Harness() {
  const [config, setConfig] = useState<JsonObject>({
    title: 'Qualification request',
    schema: {
      type: 'object',
      properties: {
        requester: { type: 'string', description: 'Person requesting the review' },
        score: { type: 'number', description: 'Qualification score' },
      },
      required: ['requester'],
    },
  })
  return <HumanFormConfigEditor nodeId="collect" config={config} onUpdate={setConfig} />
}

beforeEach(() => initI18n('en'))

describe('<HumanFormConfigEditor /> browser contract', () => {
  it('keeps field controls aligned and commits a browser rename', async () => {
    render(<Harness />)

    const name = await screen.findByLabelText('Input name: requester') as HTMLInputElement
    const type = screen.getByLabelText('Type for input requester')
    const row = screen.getByTestId('workflow-input-requester')
    const nameBox = name.getBoundingClientRect()
    const typeBox = type.getBoundingClientRect()

    expect(nameBox.width).toBeGreaterThan(0)
    expect(Math.abs(nameBox.top - typeBox.top)).toBeLessThanOrEqual(1)
    expect(Math.abs(nameBox.height - typeBox.height)).toBeLessThanOrEqual(1)
    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth)

    fireEvent.change(name, { target: { value: 'employee' } })
    fireEvent.blur(name)

    expect(await screen.findByLabelText('Input name: employee')).toHaveValue('employee')
  })
})
