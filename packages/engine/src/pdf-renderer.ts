/**
 * Markdown → PDF renderer for the `pdf.generate` tool. Pure-Node, no
 * Chromium / puppeteer / hosted service. Uses `pdfkit` programmatically
 * with a minimal Markdown parser that covers the document shapes
 * operators actually need for invoices, contracts, and weekly reports:
 *
 *   - Headings (`#`, `##`, `###`)
 *   - Paragraphs with bold (`**…**`) and italic (`*…*`) inline runs
 *   - Bulleted lists (`- ` / `* `)
 *   - Numbered lists (`1. `, `2. `, …)
 *   - Horizontal rules (`---`)
 *   - Code blocks (fenced ```` ``` ````) — rendered in a monospaced font
 *
 * HTML rendering is deliberately out of scope for v1. The tool's
 * `Remaining:` line in `docs/ROADMAP.md` flags the follow-up.
 *
 * Variable substitution: `{{varName}}` placeholders in the template are
 * replaced verbatim from the caller-supplied `variables` map BEFORE
 * Markdown parsing. Unknown placeholders are left intact and surface in
 * the rendered PDF (intentional — operators see the typo immediately
 * rather than getting a silent empty cell).
 *
 * Used by `packages/engine/src/tool-registry.ts:pdf.generate`.
 *
 * Invariants:
 * - `renderMarkdownToPdf` resolves to a `Buffer`. It throws on truly
 *   exceptional cases (template too large, pdfkit error). The tool
 *   wrapper translates throws into the standard `{ ok: false, error }`
 *   envelope.
 * - The renderer NEVER reads the filesystem, network, or process env. All
 *   inputs come through the function arguments, so it's trivially safe to
 *   call from any context (worker, api, sandbox).
 */

import PDFDocument from "pdfkit";

export type RenderMarkdownToPdfInput = {
  /** Raw Markdown source. Variables are substituted before parsing. */
  template: string;
  /** Optional `{{name}}` substitutions. Coerced to string at render time. */
  variables?: Record<string, string | number | boolean>;
  /** PDF document title — populated in the file's metadata block. */
  title?: string;
};

export type RenderMarkdownToPdfResult = {
  buffer: Buffer;
  contentLength: number;
};

const MAX_TEMPLATE_BYTES = 200_000; // mirrors the tool input schema cap

/**
 * Substitute `{{name}}` placeholders against the variables map. Unknown
 * placeholders are left untouched so operators spot the typo in the
 * rendered PDF rather than silently consuming it.
 */
export function substituteVariables(template: string, variables: Record<string, string | number | boolean> = {}): string {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (match, name) => {
    if (Object.prototype.hasOwnProperty.call(variables, name)) {
      return String(variables[name]);
    }
    return match;
  });
}

export async function renderMarkdownToPdf(input: RenderMarkdownToPdfInput): Promise<RenderMarkdownToPdfResult> {
  if (Buffer.byteLength(input.template, "utf8") > MAX_TEMPLATE_BYTES) {
    throw new Error(`pdf template exceeds ${MAX_TEMPLATE_BYTES} bytes`);
  }

  const interpolated = substituteVariables(input.template, input.variables);
  const blocks = parseMarkdownBlocks(interpolated);

  const doc = new PDFDocument({
    size: "A4",
    margin: 56,
    info: { Title: input.title ?? "Janusly PDF" },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const finished = new Promise<void>((resolveFinished, rejectFinished) => {
    doc.on("end", () => resolveFinished());
    doc.on("error", (err) => rejectFinished(err));
  });

  renderBlocks(doc, blocks);
  doc.end();
  await finished;

  const buffer = Buffer.concat(chunks);
  return { buffer, contentLength: buffer.length };
}

/* ------------------------ minimal Markdown parser ----------------------- */

type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "rule" }
  | { kind: "code"; lines: string[] };

function parseMarkdownBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    if (/^---+\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i += 1;
      continue;
    }

    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ kind: "code", lines: codeLines });
      continue;
    }

    const headingMatch = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      blocks.push({ kind: "heading", level, text: headingMatch[2] });
      i += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: false, items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i += 1;
      }
      blocks.push({ kind: "list", ordered: true, items });
      continue;
    }

    const paragraphLines: string[] = [line];
    i += 1;
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockBoundary(lines[i])) {
      paragraphLines.push(lines[i]);
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraphLines.join(" ") });
  }

  return blocks;
}

function isBlockBoundary(line: string): boolean {
  return (
    /^#{1,3}\s+/.test(line) ||
    /^\s*[-*]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^---+\s*$/.test(line) ||
    line.startsWith("```")
  );
}

/* ------------------------------ pdf rendering --------------------------- */

const HEADING_SIZES: Record<1 | 2 | 3, number> = { 1: 22, 2: 17, 3: 14 };
const BODY_FONT = "Helvetica";
const BODY_BOLD = "Helvetica-Bold";
const BODY_ITALIC = "Helvetica-Oblique";
const MONO_FONT = "Courier";

function renderBlocks(doc: PDFKit.PDFDocument, blocks: Block[]): void {
  for (const block of blocks) {
    switch (block.kind) {
      case "heading":
        doc.font(BODY_BOLD).fontSize(HEADING_SIZES[block.level]).text(block.text, { paragraphGap: 6 });
        break;
      case "paragraph":
        doc.font(BODY_FONT).fontSize(11);
        renderInlineRuns(doc, block.text);
        doc.moveDown(0.5);
        break;
      case "list": {
        doc.font(BODY_FONT).fontSize(11);
        block.items.forEach((item, index) => {
          const bullet = block.ordered ? `${index + 1}. ` : "• ";
          doc.text(bullet, { continued: true });
          renderInlineRuns(doc, item);
        });
        doc.moveDown(0.5);
        break;
      }
      case "rule":
        doc.moveDown(0.3);
        doc
          .strokeColor("#cccccc")
          .lineWidth(0.5)
          .moveTo(doc.x, doc.y)
          .lineTo(doc.x + doc.page.width - doc.page.margins.left - doc.page.margins.right, doc.y)
          .stroke();
        doc.moveDown(0.6);
        break;
      case "code":
        doc.font(MONO_FONT).fontSize(10).text(block.lines.join("\n"), { paragraphGap: 6 });
        break;
    }
  }
}

/** Render a paragraph of inline Markdown (`**bold**`, `*italic*`). */
function renderInlineRuns(doc: PDFKit.PDFDocument, text: string): void {
  const tokens = tokenizeInline(text);
  tokens.forEach((token, index) => {
    const isLast = index === tokens.length - 1;
    if (token.style === "bold") doc.font(BODY_BOLD);
    else if (token.style === "italic") doc.font(BODY_ITALIC);
    else doc.font(BODY_FONT);
    doc.text(token.text, { continued: !isLast });
  });
}

type InlineToken = { text: string; style: "plain" | "bold" | "italic" };

function tokenizeInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  const pattern = /(\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, match.index), style: "plain" });
    }
    const raw = match[0];
    if (raw.startsWith("**")) {
      tokens.push({ text: raw.slice(2, -2), style: "bold" });
    } else {
      tokens.push({ text: raw.slice(1, -1), style: "italic" });
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), style: "plain" });
  }

  if (tokens.length === 0) {
    tokens.push({ text, style: "plain" });
  }

  return tokens;
}
