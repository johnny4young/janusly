import { describe, expect, it, vi } from 'vitest'

import { openDocsUrl, parseDocsUrl } from './docs-link'

describe('docs link capability', () => {
  it.each([
    undefined,
    null,
    '',
    'not a URL',
    'http://docs.example.com',
    'javascript:alert(1)',
    'https://user:secret@docs.example.com',
  ])('rejects an unsafe or missing value: %s', (value) => {
    expect(parseDocsUrl(value)).toBeNull()
  })

  it('normalizes a credential-free HTTPS URL', () => {
    expect(parseDocsUrl('  https://docs.example.com/start?q=1  ')).toBe('https://docs.example.com/start?q=1')
  })

  it('opens the validated URL in an isolated tab', () => {
    const opened = { opener: window } as unknown as Window
    const opener = vi.fn(() => opened)

    expect(openDocsUrl('https://docs.example.com', opener)).toBe(true)
    expect(opener).toHaveBeenCalledWith('https://docs.example.com/', '_blank', 'noopener,noreferrer')
    expect(opened.opener).toBeNull()
  })

  it('does not call the opener for an invalid URL', () => {
    const opener = vi.fn(() => null)
    expect(openDocsUrl('http://docs.example.com', opener)).toBe(false)
    expect(opener).not.toHaveBeenCalled()
  })
})
