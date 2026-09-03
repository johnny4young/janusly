/**
 * Renders the closed Markdown subset shared with the PDF renderer. Walks
 * the AST produced by `parseMarkdownBlocks` (from
 * `@/lib/markdown-subset`) and emits React elements drawn
 * from a narrow set: `<h1>`–`<h3>`, `<p>`, `<ul>` / `<ol>` / `<li>`,
 * `<pre>`, `<hr>`, plus inline `<strong>` / `<em>` / `<code>` / `<a>`.
 *
 * Link safety: the shared parser only allows `http(s)://` hrefs (other
 * schemes are demoted to plain text at tokenize time). When
 * `allowOperatorLinks === false` — caller signaling the source is
 * AI-generated context — we DOUBLE down by rendering even valid `<a>`
 * tokens as plain text with the URL in parens, so a future
 * LLM-generated runbook can never become a clickable link without
 * explicit operator opt-in.
 *
 * Pure presentation — no fetch, no state. Renders `null` when the
 * source is empty or whitespace-only.
 */

import React from 'react'
import { parseMarkdownBlocks, type Block, type InlineToken } from '@/lib/markdown-subset'

export type SafeMarkdownProps = {
  source: string | null | undefined
  /**
   * Set to `false` when the source originates from an AI-generated
   * surface. Default `true` because workflow runbooks are
   * operator-supplied and operator-trusted. AI-generated runbooks must
   * explicitly pass `false`.
   */
  allowOperatorLinks?: boolean
  className?: string
}

function renderTokens(
  tokens: InlineToken[],
  allowLinks: boolean,
  prefix: string,
): React.ReactNode {
  return tokens.map((token, i) => {
    const key = `${prefix}:${i}`
    if (token.style === 'link') {
      if (allowLinks) {
        return (
          <a key={key} href={token.href} target="_blank" rel="noreferrer noopener">
            {token.text}
          </a>
        )
      }
      return (
        <span key={key}>
          {token.text} ({token.href})
        </span>
      )
    }
    if (token.style === 'bold') return <strong key={key}>{token.text}</strong>
    if (token.style === 'italic') return <em key={key}>{token.text}</em>
    if (token.style === 'code') return <code key={key}>{token.text}</code>
    return <React.Fragment key={key}>{token.text}</React.Fragment>
  })
}

function renderBlock(block: Block, idx: number, allowLinks: boolean): React.ReactNode {
  const key = `b:${idx}`
  switch (block.kind) {
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 6) as 1 | 2 | 3 | 4 | 5 | 6
      const HeadingTag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
      return (
        <HeadingTag key={key}>
          {renderTokens(block.tokens, allowLinks, key)}
        </HeadingTag>
      )
    }
    case 'paragraph':
      return <p key={key}>{renderTokens(block.tokens, allowLinks, key)}</p>
    case 'list': {
      const ListTag = block.ordered ? 'ol' : 'ul'
      return (
        <ListTag key={key}>
          {block.items.map((item, i) => (
            <li key={`${key}:${i}`}>{renderTokens(item, allowLinks, `${key}:${i}`)}</li>
          ))}
        </ListTag>
      )
    }
    case 'rule':
      return <hr key={key} />
    case 'code':
      return (
        <pre key={key}>
          <code>{block.lines.join('\n')}</code>
        </pre>
      )
    case 'table':
      // Tables are produced by the HTML walker (not the Markdown
      // subset). Markdown source never emits a table block, so this
      // branch is unreachable from the runbook path — keep it
      // exhaustive against the shared `Block` discriminator.
      return (
        <table key={key}>
          <tbody>
            {block.rows.map((row, ri) => (
              <tr key={`${key}:r:${ri}`}>
                {row.map((cell, ci) => {
                  const CellTag = cell.isHeader ? 'th' : 'td'
                  return (
                    <CellTag key={`${key}:r:${ri}:c:${ci}`} colSpan={cell.colspan}>
                      {renderTokens(cell.tokens, allowLinks, `${key}:r:${ri}:c:${ci}`)}
                    </CellTag>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )
    default: {
      const exhaustive: never = block
      throw new Error(`unreachable block kind: ${String(exhaustive)}`)
    }
  }
}

export function SafeMarkdown({
  source,
  allowOperatorLinks = true,
  className,
}: SafeMarkdownProps): React.ReactElement | null {
  if (!source || source.trim().length === 0) return null
  let blocks: Block[]
  try {
    blocks = parseMarkdownBlocks(source)
  } catch {
    // Parser hard-caps (too many blocks / inline tokens) throw — degrade
    // to a plain-text rendering so the operator still sees something.
    return (
      <div className={className} data-testid="safe-markdown-fallback">
        <pre>{source}</pre>
      </div>
    )
  }
  return (
    <div className={className} data-testid="safe-markdown">
      {blocks.map((block, idx) => renderBlock(block, idx, allowOperatorLinks))}
    </div>
  )
}
