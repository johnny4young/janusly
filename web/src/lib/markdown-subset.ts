/**
 * Closed Markdown subset shared between the engine PDF renderer and the
 * web `<SafeMarkdown />` component. Pure string→AST parsing — zero runtime
 * dependencies, safe to import from any layer including the browser bundle.
 *
 * Grammar:
 *  - **Headings**: `# H1` / `## H2` / `### H3` (levels 1-3 only).
 *  - **Paragraphs**: lines joined with a space until a blank line or block
 *    boundary.
 *  - **Bulleted lists**: lines starting with `-` or `*`.
 *  - **Ordered lists**: lines starting with `1.` etc.
 *  - **Horizontal rules**: a line of `---` (three or more dashes).
 *  - **Fenced code blocks**: ``` … ```.
 *  - **Inline runs**: `**bold**`, `*italic*`, and `[text](https://...)`
 *    links (http / https only — `javascript:` and other schemes are
 *    rejected and the bracket text renders as plain).
 *
 * Variable substitution (`{{name}}`) runs separately via
 * `substituteVariables` BEFORE parsing. Unknown placeholders are left
 * intact so operators spot template typos in the rendered output rather
 * than silently consuming them.
 *
 * The output `Block[]` AST is intentionally also used by the engine's
 * HTML walker (`parseAndSanitizeHtml`) so both input dialects normalize
 * to the same shape and the renderer (PDF or React) doesn't have to
 * know about either source format.
 *
 * Invariants:
 *  - `parseMarkdownBlocks` NEVER throws on malformed input — every block
 *    boundary degrades gracefully (a stray `**` becomes a plain `*`).
 *    It DOES throw when the output exceeds `MAX_BLOCKS` block elements
 *    or `MAX_TOKENS_PER_BLOCK` inline tokens in any one block, since
 *    those caps protect downstream renderers from pathological inputs.
 *  - The link href validator only allows `http(s)://` so an embedded
 *    `[click](javascript:alert(1))` cannot survive the parse step. This
 *    is defense-in-depth on top of any per-renderer escaping.
 */

/** Maximum number of block elements in a single parsed AST. */
export const MAX_BLOCKS = 5_000

/** Maximum number of inline tokens in a single block. */
export const MAX_TOKENS_PER_BLOCK = 2_000

export type InlineStyle = "plain" | "bold" | "italic" | "code"

export type InlineToken =
  | { text: string; style: InlineStyle }
  | { text: string; style: "link"; href: string }

export type TableCell = {
  tokens: InlineToken[]
  isHeader: boolean
  colspan: number
}

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; tokens: InlineToken[] }
  | { kind: "paragraph"; tokens: InlineToken[] }
  | { kind: "list"; ordered: boolean; items: InlineToken[][] }
  | { kind: "rule" }
  | { kind: "code"; lines: string[] }
  | { kind: "table"; rows: TableCell[][]; headerRowCount: number }

/**
 * Substitute `{{name}}` placeholders against the variables map. Unknown
 * placeholders are left untouched so operators spot the typo in the
 * rendered output rather than silently consuming it. Prototype keys are
 * ignored to avoid pollution.
 */
export function substituteVariables(
  template: string,
  variables: Record<string, string | number | boolean> = {},
): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (match, name) => {
    if (Object.hasOwn(variables, name)) {
      return String(variables[name])
    }
    return match
  })
}

/**
 * Parse the Markdown subset into the shared `Block[]` AST. Pure function
 * with no I/O; safe to call from any context.
 */
export function parseMarkdownBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n")
  const blocks: Block[] = []
  let i = 0

  function pushBlock(block: Block): void {
    if (blocks.length >= MAX_BLOCKS) {
      throw new Error(`markdown source exceeds ${MAX_BLOCKS} block elements`)
    }
    blocks.push(block)
  }

  while (i < lines.length) {
    const line = lines[i]

    if (/^\s*$/.test(line)) {
      i += 1
      continue
    }

    if (/^---+\s*$/.test(line)) {
      pushBlock({ kind: "rule" })
      i += 1
      continue
    }

    if (line.startsWith("```")) {
      const codeLines: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      pushBlock({ kind: "code", lines: codeLines })
      continue
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+?)\s*$/)
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3
      pushBlock({ kind: "heading", level, tokens: tokenizeMarkdownInline(headingMatch[2]) })
      i += 1
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: InlineToken[][] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(tokenizeMarkdownInline(lines[i].replace(/^\s*[-*]\s+/, "")))
        i += 1
      }
      pushBlock({ kind: "list", ordered: false, items })
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: InlineToken[][] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(tokenizeMarkdownInline(lines[i].replace(/^\s*\d+\.\s+/, "")))
        i += 1
      }
      pushBlock({ kind: "list", ordered: true, items })
      continue
    }

    const paragraphLines: string[] = [line]
    i += 1
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockBoundary(lines[i])) {
      paragraphLines.push(lines[i])
      i += 1
    }
    pushBlock({ kind: "paragraph", tokens: tokenizeMarkdownInline(paragraphLines.join(" ")) })
  }

  return blocks
}

function isBlockBoundary(line: string): boolean {
  return (
    /^#{1,3}\s+/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^---+\s*$/.test(line) ||
    line.startsWith("```")
  )
}

/**
 * Tokenize a Markdown text run into `plain` / `bold` (`**…**`) /
 * `italic` (`*…*`) / `link` (`[text](url)`) inline tokens. Links accept
 * only `http(s)://` URLs; any other scheme falls through and the bracket
 * text renders as plain. Used at parse time so the renderer doesn't have
 * to know about Markdown syntax.
 */
export function tokenizeMarkdownInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  // Order matters: link pattern first (greedier), then bold, then italic.
  // Each alternative is captured as a whole match so we can dispatch on
  // the leading character.
  const pattern = /(\[[^\]]+\]\([^)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g
  let lastIndex = 0
  for (const match of text.matchAll(pattern)) {
    const idx = match.index ?? 0
    if (idx > lastIndex) {
      pushInline(tokens, { text: text.slice(lastIndex, idx), style: "plain" })
    }
    const raw = match[0]
    if (raw.startsWith("[")) {
      const close = raw.indexOf("](")
      const linkText = raw.slice(1, close)
      const href = raw.slice(close + 2, -1).trim()
      if (/^https?:\/\//i.test(href)) {
        pushInline(tokens, { text: linkText, style: "link", href })
      } else {
        // Unsafe scheme — fall through, render the bracketed text plain.
        pushInline(tokens, { text: linkText, style: "plain" })
      }
    } else if (raw.startsWith("**")) {
      pushInline(tokens, { text: raw.slice(2, -2), style: "bold" })
    } else {
      pushInline(tokens, { text: raw.slice(1, -1), style: "italic" })
    }
    lastIndex = idx + raw.length
  }

  if (lastIndex < text.length) {
    pushInline(tokens, { text: text.slice(lastIndex), style: "plain" })
  }

  if (tokens.length === 0) {
    tokens.push({ text, style: "plain" })
  }

  return tokens
}

function pushInline(target: InlineToken[], token: InlineToken): void {
  if (target.length >= MAX_TOKENS_PER_BLOCK) {
    throw new Error(`markdown source exceeds ${MAX_TOKENS_PER_BLOCK} inline tokens in one block`)
  }
  target.push(token)
}
