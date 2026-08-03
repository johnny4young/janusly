import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'

import { initI18n } from '../i18n'
import type { JsonObject, ToolSchema } from '../types'
import { ToolInputFields } from './ToolInputFields'

const tool: ToolSchema = {
  name: 'demo.configure',
  description: 'Configure a demo.',
  required: ['title', 'payload'],
  optional: ['attempts', 'enabled', 'region'],
  inputExample: { title: 'Demo', payload: { ready: true } },
  inputFields: [
    { name: 'title', kind: 'string', required: true },
    { name: 'payload', kind: 'json', required: true },
    { name: 'attempts', kind: 'integer', required: false },
    { name: 'enabled', kind: 'boolean', required: false },
    { name: 'region', kind: 'string', required: false, options: ['us', 'eu'] },
  ],
  writeSide: false,
}

beforeEach(() => initI18n('en'))

describe('<ToolInputFields />', () => {
  it('authors typed values while preserving unknown advanced fields', () => {
    function Harness() {
      const [input, setInput] = useState<JsonObject>({
        title: 'Demo',
        payload: { ready: true },
        futureFlag: 'preserved',
      })
      return (
        <>
          <ToolInputFields scope="demo" tool={tool} input={input} onChange={value => setInput(value as JsonObject)} />
          <output data-testid="state">{JSON.stringify(input)}</output>
        </>
      )
    }
    render(<Harness />)

    expect(screen.getByLabelText(/^Title/)).toHaveValue('Demo')
    expect(screen.getByLabelText(/^Payload/)).toHaveValue('{\n  "ready": true\n}')

    fireEvent.change(screen.getByLabelText(/^Attempts/), { target: { value: '3' } })
    fireEvent.blur(screen.getByLabelText(/^Attempts/))
    fireEvent.change(screen.getByLabelText(/^Enabled/), { target: { value: 'false' } })
    fireEvent.blur(screen.getByLabelText(/^Enabled/))
    fireEvent.change(screen.getByLabelText(/^Region/), { target: { value: 'eu' } })
    fireEvent.blur(screen.getByLabelText(/^Region/))

    expect(JSON.parse(screen.getByTestId('state').textContent ?? '{}')).toEqual({
      title: 'Demo',
      payload: { ready: true },
      attempts: 3,
      enabled: false,
      region: 'eu',
      futureFlag: 'preserved',
    })
  })

  it('keeps complete expressions and blocks malformed typed drafts locally', () => {
    function Harness() {
      const [input, setInput] = useState<JsonObject>({
        title: 'Demo',
        payload: { ready: true },
      })
      return (
        <>
          <ToolInputFields scope="demo" tool={tool} input={input} onChange={value => setInput(value as JsonObject)} />
          <output data-testid="state">{JSON.stringify(input)}</output>
        </>
      )
    }
    render(<Harness />)

    const attempts = screen.getByLabelText(/^Attempts/)
    fireEvent.change(attempts, { target: { value: '1.5' } })
    fireEvent.blur(attempts)
    expect(screen.getByRole('alert')).toHaveTextContent('whole number')
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '{}')).not.toHaveProperty('attempts')

    fireEvent.change(attempts, { target: { value: '{{context.input.retries}}' } })
    fireEvent.blur(attempts)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '{}')).toMatchObject({
      attempts: '{{context.input.retries}}',
    })

    const region = screen.getByLabelText(/^Region/)
    fireEvent.change(region, { target: { value: 'other' } })
    fireEvent.blur(region)
    expect(screen.getByRole('alert')).toHaveTextContent('available option')
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '{}')).not.toHaveProperty('region')
  })

  it('fails closed to Advanced JSON for a malformed persisted root', () => {
    render(
      <ToolInputFields
        scope="demo"
        tool={tool}
        input={['not', 'an', 'object']}
        onChange={() => undefined}
      />,
    )

    expect(screen.getByRole('alert')).toHaveTextContent('not an object')
    expect(screen.queryByLabelText(/^Title/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByText('Advanced JSON'))
    expect(screen.getByLabelText('Tool input')).toHaveValue('[\n  "not",\n  "an",\n  "object"\n]')
  })

  it('refreshes structured controls after an Advanced JSON edit', () => {
    function Harness() {
      const [input, setInput] = useState<JsonObject>({
        title: 'Before',
        payload: { ready: true },
      })
      return <ToolInputFields scope="demo" tool={tool} input={input} onChange={value => setInput(value as JsonObject)} />
    }
    render(<Harness />)

    fireEvent.click(screen.getByText('Advanced JSON'))
    const advanced = screen.getByLabelText('Tool input')
    fireEvent.change(advanced, {
      target: { value: '{"title":"After","payload":{"ready":false}}' },
    })
    fireEvent.blur(advanced)

    expect(screen.getByLabelText(/^Title/)).toHaveValue('After')
    expect(screen.getByLabelText(/^Payload/)).toHaveValue('{\n  "ready": false\n}')
  })

  it('treats an absent input as an empty object that can be configured', () => {
    function Harness() {
      const [input, setInput] = useState<unknown>(undefined)
      return (
        <>
          <ToolInputFields scope="demo" tool={tool} input={input} onChange={setInput} />
          <output data-testid="state">{JSON.stringify(input)}</output>
        </>
      )
    }
    render(<Harness />)

    const title = screen.getByLabelText(/^Title/)
    expect(title).toHaveValue('')
    expect(screen.queryByText(/not an object/i)).not.toBeInTheDocument()

    fireEvent.change(title, { target: { value: 'Configured later' } })
    fireEvent.blur(title)
    expect(JSON.parse(screen.getByTestId('state').textContent ?? '{}')).toEqual({
      title: 'Configured later',
    })
  })
})
