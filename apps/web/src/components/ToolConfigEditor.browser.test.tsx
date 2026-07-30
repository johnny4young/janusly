import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { initI18n } from '../i18n'
import type { ToolSchema } from '../types'
import { ToolConfigEditor } from './ToolConfigEditor'

const tools: ToolSchema[] = [{
  name: 'github.create_issue',
  description: 'Create a GitHub issue using a stored PAT credential.',
  descriptionCode: 'github-create-issue',
  required: ['credential', 'owner', 'repo', 'title'],
  optional: ['body', 'labels', 'assignees'],
  inputExample: {
    credential: 'bot-github',
    owner: 'janusly',
    repo: 'demo',
    title: 'Incident triage',
    body: 'Details…',
  },
  writeSide: true,
}, {
  name: 'text.uppercase',
  description: 'Convert text to uppercase.',
  descriptionCode: 'text-uppercase',
  required: ['value'],
  inputExample: { value: 'hello' },
  writeSide: false,
}]

beforeAll(() => initI18n('en'))

describe('<ToolConfigEditor /> browser smoke', () => {
  it('keeps catalog controls aligned and exposes write capability before execution', () => {
    render(
      <div style={{ width: 420 }}>
        <ToolConfigEditor
          nodeId="action"
          config={{
            tool: 'github.create_issue',
            input: tools[0]!.inputExample,
          }}
          tools={tools}
          onUpdate={vi.fn()}
        />
      </div>,
    )

    const search = screen.getByLabelText('Find a tool')
    const picker = screen.getByLabelText('Tool')
    const input = screen.getByLabelText('Tool input')
    const bounds = [search, picker, input].map(field => field.getBoundingClientRect())
    expect(bounds.every(({ width, height }) => width >= 400 && height > 0)).toBe(true)
    expect(Math.max(...bounds.map(({ left }) => left)) - Math.min(...bounds.map(({ left }) => left)))
      .toBeLessThanOrEqual(1)
    expect(Math.max(...bounds.map(({ right }) => right)) - Math.min(...bounds.map(({ right }) => right)))
      .toBeLessThanOrEqual(1)
    expect(screen.getByTestId('tool-capability')).toHaveTextContent('May change external systems')

    fireEvent.change(search, { target: { value: 'uppercase' } })
    expect(screen.getByRole('option', { name: 'text.uppercase' })).toBeInTheDocument()
    expect(picker).toHaveValue('github.create_issue')
  })
})
