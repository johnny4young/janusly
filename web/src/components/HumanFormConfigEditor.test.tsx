import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { initI18n } from '../i18n'
import type { JsonObject } from '../types'
import { HumanFormConfigEditor } from './TimingConfigEditors'

function Harness({ initialConfig }: { initialConfig: JsonObject }) {
  const [config, setConfig] = useState(initialConfig)
  return (
    <>
      <HumanFormConfigEditor nodeId="collect" config={config} onUpdate={setConfig} />
      <output data-testid="form-config-state">{JSON.stringify(config)}</output>
    </>
  )
}

const state = () => JSON.parse(screen.getByTestId('form-config-state').textContent ?? '{}')

beforeEach(() => initI18n('en'))

describe('<HumanFormConfigEditor />', () => {
  it('authors scalar fields, descriptions, and requirements without JSON', async () => {
    render(<Harness initialConfig={{
      title: 'Request review',
      schema: {
        type: 'object',
        properties: {
          requester: { type: 'string', description: 'Who needs help?' },
          urgent: { type: 'boolean' },
        },
        required: ['requester'],
      },
    }} />)

    const requester = await screen.findByLabelText('Input name: requester')
    fireEvent.change(requester, { target: { value: 'employee' } })
    fireEvent.blur(requester)
    fireEvent.change(screen.getByLabelText('Description for input employee'), {
      target: { value: 'Employee requesting review' },
    })
    fireEvent.change(screen.getByLabelText('Type for input urgent'), {
      target: { value: 'number' },
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Required input: urgent' }))
    fireEvent.click(screen.getByTestId('workflow-input-add'))

    expect(Array.from((screen.getByLabelText('Type for input input') as HTMLSelectElement).options).map(option => option.text)).toEqual([
      'Text',
      'Number',
      'True / false',
    ])
    expect(state().schema).toEqual({
      type: 'object',
      properties: {
        employee: { type: 'string', description: 'Employee requesting review' },
        urgent: { type: 'number' },
        input: { type: 'string' },
      },
      required: ['employee', 'urgent'],
    })
  })

  it('keeps an empty object schema after the final field is removed', async () => {
    render(<Harness initialConfig={{
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
      },
    }} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Remove input answer' }))

    expect(state().schema).toEqual({ type: 'object', properties: {} })
    expect(screen.getByText('No declared inputs yet.')).toBeVisible()
  })

  it('preserves nested schemas for Advanced JSON instead of flattening them', async () => {
    const schema = {
      type: 'object',
      properties: {
        requester: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      },
      required: ['requester'],
    }
    render(<Harness initialConfig={{ schema }} />)

    expect(await screen.findByText(
      'This object contract is preserved because the guided editor cannot represent every field.',
    )).toBeVisible()
    expect(screen.queryByTestId('workflow-input-add')).toBeNull()
    expect(state().schema).toEqual(schema)
  })
})
