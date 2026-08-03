import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'

import { SafeMarkdown } from './SafeMarkdown'

afterEach(() => cleanup())

describe('SafeMarkdown', () => {
  it('renders nothing for empty source', () => {
    const { container } = render(<SafeMarkdown source="" />)
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing for whitespace-only source', () => {
    const { container } = render(<SafeMarkdown source={'   \n\n  '} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders headings, paragraphs, lists, and code blocks', () => {
    const { container } = render(
      <SafeMarkdown
        source={[
          '# Title',
          '',
          'A paragraph with **bold** and *italic*.',
          '',
          '- bullet one',
          '- bullet two',
          '',
          '```',
          'const x = 1',
          '```',
        ].join('\n')}
      />,
    )
    expect(container.querySelector('h1')?.textContent).toBe('Title')
    expect(container.querySelectorAll('p').length).toBeGreaterThan(0)
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('em')?.textContent).toBe('italic')
    expect(container.querySelectorAll('ul li').length).toBe(2)
    expect(container.querySelector('pre code')?.textContent).toBe('const x = 1')
  })

  it('renders [text](url) as a clickable anchor when allowOperatorLinks (default)', () => {
    const { container } = render(
      <SafeMarkdown source="See [Linear](https://linear.app/acme/payouts)." />,
    )
    const anchor = container.querySelector('a')
    expect(anchor).not.toBeNull()
    expect(anchor?.getAttribute('href')).toBe('https://linear.app/acme/payouts')
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toContain('noreferrer')
  })

  it('demotes links to plain text when allowOperatorLinks=false', () => {
    const { container } = render(
      <SafeMarkdown
        source="See [Linear](https://linear.app/acme/payouts)."
        allowOperatorLinks={false}
      />,
    )
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('Linear')
    expect(container.textContent).toContain('https://linear.app/acme/payouts')
  })

  it('does not render unsafe javascript: links (parser rejects, becomes plain)', () => {
    const { container } = render(
      <SafeMarkdown source="[click](javascript:alert(1))" />,
    )
    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click')
  })
})
