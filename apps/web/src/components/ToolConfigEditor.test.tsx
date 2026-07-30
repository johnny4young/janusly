import { fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { initI18n } from '../i18n'
import type { JsonObject, ToolSchema } from '../types'
import { ToolConfigEditor } from './ToolConfigEditor'

const tools: ToolSchema[] = [
  {
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
  },
  {
    name: 'text.uppercase',
    description: 'Convert text to uppercase.',
    descriptionCode: 'text-uppercase',
    required: ['value'],
    inputExample: { value: 'hello' },
    writeSide: false,
  },
]

beforeEach(() => initI18n('en'))

describe('<ToolConfigEditor />', () => {
  it('searches the catalog by localized purpose while preserving the selected tool', () => {
    render(
      <ToolConfigEditor
        nodeId="transform"
        config={{ tool: 'text.uppercase', input: { value: 'hello' } }}
        tools={tools}
        onUpdate={vi.fn()}
      />,
    )

    const search = screen.getByLabelText('Find a tool')
    fireEvent.change(search, { target: { value: 'stored PAT' } })

    const picker = screen.getByLabelText('Tool')
    expect(picker).toHaveValue('text.uppercase')
    expect(screen.getByRole('option', { name: 'github.create_issue' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'text.uppercase' })).toBeInTheDocument()

    fireEvent.change(search, { target: { value: 'missing capability' } })
    expect(screen.getByTestId('tool-search-empty')).toBeVisible()
    expect(picker).toHaveValue('text.uppercase')
  })

  it('replaces stale input when the operator changes tool contracts', () => {
    const onUpdate = vi.fn()
    render(
      <ToolConfigEditor
        nodeId="action"
        config={{
          tool: 'text.uppercase',
          input: { value: '{{context.input.title}}', stale: true },
          retries: 2,
        }}
        tools={tools}
        onUpdate={onUpdate}
      />,
    )

    fireEvent.change(screen.getByLabelText('Tool'), {
      target: { value: 'github.create_issue' },
    })

    expect(onUpdate).toHaveBeenLastCalledWith({
      tool: 'github.create_issue',
      input: {
        credential: 'bot-github',
        owner: 'janusly',
        repo: 'demo',
        title: 'Incident triage',
        body: 'Details…',
      },
      retries: 2,
    })
  })

  it('explains effect capability and restores the selected tool example', () => {
    const onUpdate = vi.fn()
    const { rerender } = render(
      <ToolConfigEditor
        nodeId="action"
        config={{
          tool: 'github.create_issue',
          input: { credential: 'prod', repo: 'acme/app', title: 'Custom title' },
        }}
        tools={tools}
        onUpdate={onUpdate}
      />,
    )

    expect(screen.getByTestId('tool-capability')).toHaveTextContent('May change external systems')
    expect(screen.getByText(/Write-side calls are skipped during validation runs/)).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Restore example input' }))
    expect(onUpdate).toHaveBeenLastCalledWith({
      tool: 'github.create_issue',
      input: {
        credential: 'bot-github',
        owner: 'janusly',
        repo: 'demo',
        title: 'Incident triage',
        body: 'Details…',
      },
    })

    rerender(
      <ToolConfigEditor
        nodeId="action"
        config={{ tool: 'text.uppercase', input: { value: 'hello' } }}
        tools={tools}
        onUpdate={onUpdate}
      />,
    )
    expect(screen.getByTestId('tool-capability')).toHaveTextContent('Read-only')
    expect(screen.getByText(/without declaring an external write effect/)).toBeVisible()
  })

  it('keeps an unregistered persisted tool visible and clearly invalid', () => {
    render(
      <ToolConfigEditor
        nodeId="legacy"
        config={{ tool: 'legacy.missing', input: { value: 'preserved' } }}
        tools={tools}
        onUpdate={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('Tool')).toHaveValue('legacy.missing')
    expect(screen.getByTestId('unknown-tool-warning')).toHaveTextContent('not registered')
    expect((screen.getByLabelText('Tool input') as HTMLTextAreaElement).value).toContain('preserved')
  })

  it('keeps the input and resilience controls progressive until a tool is chosen', () => {
    function Harness() {
      const [config, setConfig] = useState<JsonObject>({})
      return (
        <ToolConfigEditor
          nodeId="new-tool"
          config={config}
          tools={tools}
          onUpdate={setConfig}
        />
      )
    }
    render(<Harness />)

    expect(screen.queryByLabelText('Tool input')).not.toBeInTheDocument()
    expect(screen.getByTestId('resilience-fieldset')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Tool'), { target: { value: 'text.uppercase' } })
    expect((screen.getByLabelText('Tool input') as HTMLTextAreaElement).value).toContain('hello')
  })
})
