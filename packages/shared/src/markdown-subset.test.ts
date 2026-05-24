import { describe, expect, it } from 'vitest'

import {
  MAX_BLOCKS,
  MAX_TOKENS_PER_BLOCK,
  parseMarkdownBlocks,
  substituteVariables,
  tokenizeMarkdownInline,
} from './markdown-subset'

describe('substituteVariables', () => {
  it('substitutes known placeholders verbatim', () => {
    expect(substituteVariables('Hello {{name}} ({{count}})', { name: 'Ada', count: 7 })).toBe(
      'Hello Ada (7)',
    )
  })

  it('leaves unknown placeholders intact so operators spot template typos', () => {
    expect(substituteVariables('Hello {{name}} {{missing}}', { name: 'Ada' })).toBe(
      'Hello Ada {{missing}}',
    )
  })

  it('coerces booleans and numbers to strings', () => {
    expect(substituteVariables('active={{active}} count={{count}}', { active: true, count: 0 })).toBe(
      'active=true count=0',
    )
  })

  it('ignores prototype keys to avoid pollution', () => {
    expect(substituteVariables('Hello {{__proto__}}', {})).toBe('Hello {{__proto__}}')
  })
})

describe('parseMarkdownBlocks — block kinds', () => {
  it('parses heading levels 1-3', () => {
    const blocks = parseMarkdownBlocks('# A\n## B\n### C')
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 })
    expect(blocks[1]).toMatchObject({ kind: 'heading', level: 2 })
    expect(blocks[2]).toMatchObject({ kind: 'heading', level: 3 })
  })

  it('parses bulleted lists', () => {
    const blocks = parseMarkdownBlocks('- one\n- two\n- three')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: false })
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(3)
  })

  it('parses ordered lists', () => {
    const blocks = parseMarkdownBlocks('1. first\n2. second')
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true })
  })

  it('parses fenced code blocks', () => {
    const blocks = parseMarkdownBlocks('```\nconst x = 1\n```')
    expect(blocks[0]).toEqual({ kind: 'code', lines: ['const x = 1'] })
  })

  it('parses horizontal rules', () => {
    const blocks = parseMarkdownBlocks('text\n\n---\n\nmore')
    expect(blocks.some((b) => b.kind === 'rule')).toBe(true)
  })

  it('joins paragraph lines into one block', () => {
    const blocks = parseMarkdownBlocks('line one\nline two\n\nseparate')
    const paragraphs = blocks.filter((b) => b.kind === 'paragraph')
    expect(paragraphs).toHaveLength(2)
  })
})

describe('tokenizeMarkdownInline — inline runs', () => {
  it('emits bold tokens for **text**', () => {
    const tokens = tokenizeMarkdownInline('hi **bold** end')
    expect(tokens).toEqual([
      { text: 'hi ', style: 'plain' },
      { text: 'bold', style: 'bold' },
      { text: ' end', style: 'plain' },
    ])
  })

  it('emits italic tokens for *text*', () => {
    const tokens = tokenizeMarkdownInline('an *italic* run')
    expect(tokens).toContainEqual({ text: 'italic', style: 'italic' })
  })

  it('emits link tokens for [text](https://...)', () => {
    const tokens = tokenizeMarkdownInline('See [Linear](https://linear.app/acme/project) please')
    expect(tokens).toContainEqual({ text: 'Linear', style: 'link', href: 'https://linear.app/acme/project' })
  })

  it('emits link tokens for http (not just https)', () => {
    const tokens = tokenizeMarkdownInline('[insecure](http://example.com)')
    expect(tokens).toContainEqual({ text: 'insecure', style: 'link', href: 'http://example.com' })
  })

  it('rejects javascript: URLs — falls back to plain text', () => {
    const tokens = tokenizeMarkdownInline('[click](javascript:alert(1))')
    expect(tokens).toContainEqual({ text: 'click', style: 'plain' })
    expect(tokens).not.toContainEqual(
      expect.objectContaining({ style: 'link', href: 'javascript:alert(1)' }),
    )
  })

  it('rejects mailto: URLs as link tokens (only http/https allowed)', () => {
    const tokens = tokenizeMarkdownInline('[email](mailto:a@b.c)')
    expect(tokens.find((t) => t.style === 'link')).toBeUndefined()
  })

  it('returns a single plain token for text with no markup', () => {
    expect(tokenizeMarkdownInline('hello world')).toEqual([{ text: 'hello world', style: 'plain' }])
  })
})

describe('parseMarkdownBlocks — size caps', () => {
  it(`rejects more than ${MAX_BLOCKS} block elements`, () => {
    const tooMany = Array.from({ length: MAX_BLOCKS + 5 }, (_, i) => `# h${i}`).join('\n\n')
    expect(() => parseMarkdownBlocks(tooMany)).toThrow(/exceeds 5000/)
  })

  it(`rejects more than ${MAX_TOKENS_PER_BLOCK} inline tokens in one block`, () => {
    // Each `**a**` token is 5 chars and produces a single bold token plus a
    // surrounding plain token. Generate enough to overflow the cap.
    const stream = Array.from({ length: MAX_TOKENS_PER_BLOCK + 50 }, () => '**a**').join('x')
    expect(() => parseMarkdownBlocks(stream)).toThrow(/exceeds 2000/)
  })
})
