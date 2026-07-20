/**
 * Real-browser interaction coverage for the loop `for_each` authoring form.
 */

import { useState } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { initI18n } from '../i18n'
import type { JsonObject } from '../types'
import { QuickConfigEditor } from './QuickConfigEditor'

beforeAll(() => initI18n('en'))

describe('<QuickConfigEditor /> loop for_each browser contract', () => {
  it('reveals the bounded tool controls and switches failure-budget units', async () => {
    const onUpdate = vi.fn()
    function Harness() {
      const [config, setConfig] = useState<JsonObject>({
          mode: 'for_each',
          items: 'alpha,beta,gamma',
          tool: 'text.uppercase',
          input: { value: '{{item}}' },
          concurrency: 4,
          toleratedFailureCount: 1,
        })
      return <QuickConfigEditor
        nodeId="batch"
        type="loop"
        config={config}
        tools={[{
          name: 'text.uppercase',
          description: 'Convert text to uppercase.',
          descriptionCode: 'text-uppercase',
          required: ['value'],
          inputExample: { value: 'hello' },
        }]}
        onUpdate={(next) => {
          onUpdate(next)
          setConfig(next)
        }}
      />
    }
    render(<Harness />)

    expect(screen.getByLabelText('Processing mode')).toHaveValue('for_each')
    expect(screen.getByLabelText('Tool')).toHaveValue('text.uppercase')
    expect(screen.getByLabelText('Concurrency')).toHaveValue(4)
    expect(screen.getByLabelText('Failed items allowed')).toHaveValue(1)

    fireEvent.change(screen.getByLabelText('Failure budget'), { target: { value: 'percentage' } })
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({
      toleratedFailurePercentage: 0,
    }))
    expect(onUpdate.mock.calls.at(-1)?.[0]).not.toHaveProperty('toleratedFailureCount')
    const percentage = screen.getByLabelText('Failed percentage allowed')
    expect(percentage).toHaveValue(0)

    fireEvent.change(percentage, { target: { value: '0.5' } })
    fireEvent.blur(percentage)
    expect(onUpdate.mock.calls.at(-1)?.[0]).toMatchObject({ toleratedFailurePercentage: 0.5 })
    expect(screen.getByLabelText('Failed percentage allowed')).toHaveValue(0.5)
  })
})
