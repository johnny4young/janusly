/**
 * Tests for the Markdown + HTML → PDF renderers used by the `pdf.generate`
 * tool. Asserts:
 *  - the variable-substitution contract (unknown placeholders left intact
 *    so operators see typos),
 *  - the PDF magic-bytes header on both renderers,
 *  - the size cap (200KB) on both renderers,
 *  - the HTML sanitization contract (closed deny-set drops content;
 *    `on*` attributes dropped; `javascript:` href rejected; nesting cap),
 *  - table rendering shape (cells appear in the byte stream; header bold).
 */
import { describe, expect, it } from "vitest";

import {
  HTML_DROP_TAGS_LIST,
  parseAndSanitizeHtml,
  renderHtmlToPdf,
  renderMarkdownToPdf,
  substituteVariables,
} from "./pdf-renderer";
import type { Block, InlineToken, TableCell } from "./pdf-renderer";

/**
 * pdfkit Flate-compresses content streams by default, so the body text
 * doesn't appear as literal bytes in the rendered buffer. Sanitization
 * + structure assertions therefore run against the parser's `Block[]`
 * intermediate representation. The `renderHtmlToPdf` smoke cases below
 * confirm the buffer is well-formed; per-tag content checks happen here.
 */
function tokensText(tokens: InlineToken[]): string {
  return tokens.map((t) => t.text).join("");
}

function cellsText(cells: TableCell[]): string[] {
  return cells.map((c) => c.tokens.map((t) => t.text).join(""));
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "heading":
      return tokensText(block.tokens);
    case "paragraph":
      return tokensText(block.tokens);
    case "list":
      return block.items.map(tokensText).join("|");
    case "code":
      return block.lines.join("\n");
    case "rule":
      return "[rule]";
    case "table":
      return block.rows.map((r) => cellsText(r).join("|")).join("\n");
  }
}

describe("substituteVariables", () => {
  it("substitutes known placeholders verbatim", () => {
    const out = substituteVariables("Hello {{name}} ({{count}})", { name: "Ada", count: 7 });
    expect(out).toBe("Hello Ada (7)");
  });

  it("leaves unknown placeholders intact so operators spot template typos", () => {
    const out = substituteVariables("Hello {{name}} {{missing}}", { name: "Ada" });
    expect(out).toBe("Hello Ada {{missing}}");
  });

  it("coerces booleans + numbers to strings", () => {
    const out = substituteVariables("active={{active}} count={{count}}", { active: true, count: 0 });
    expect(out).toBe("active=true count=0");
  });

  it("ignores prototype keys to avoid pollution", () => {
    const out = substituteVariables("Hello {{__proto__}}", {});
    expect(out).toBe("Hello {{__proto__}}");
  });
});

describe("renderMarkdownToPdf", () => {
  it("produces a non-empty PDF buffer with the %PDF- magic bytes header", async () => {
    const { buffer, contentLength } = await renderMarkdownToPdf({
      template: "# Invoice {{number}}\n\nAmount: **{{amount}}**\n\n- Item one\n- Item two\n",
      variables: { number: "INV-001", amount: "$100.00" },
    });
    expect(contentLength).toBeGreaterThan(500);
    expect(buffer.length).toBe(contentLength);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders multiple block types without throwing", async () => {
    const template = [
      "# Heading 1",
      "## Heading 2",
      "### Heading 3",
      "",
      "Paragraph with **bold** and *italic* runs.",
      "",
      "- bullet a",
      "- bullet b",
      "",
      "1. ordered a",
      "2. ordered b",
      "",
      "---",
      "",
      "```",
      "code line",
      "```",
    ].join("\n");
    const { buffer } = await renderMarkdownToPdf({ template });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("rejects templates over the size cap", async () => {
    const huge = "x".repeat(200_001);
    await expect(renderMarkdownToPdf({ template: huge })).rejects.toThrow(/exceeds/);
  });

  it("rejects templates whose variables expand beyond the size cap", async () => {
    const huge = "x".repeat(200_001);
    await expect(renderMarkdownToPdf({
      template: "{{payload}}",
      variables: { payload: huge },
    })).rejects.toThrow(/exceeds/);
  });

  it("uses the supplied title in the PDF metadata block", async () => {
    const { buffer } = await renderMarkdownToPdf({
      template: "# Hello",
      title: "Quarterly Report Q1",
    });
    // pdfkit writes Title in the PDF /Info dictionary; check the title
    // appears somewhere in the body bytes (encoded as UTF-16 BE in
    // pdfkit's default Info string format).
    expect(buffer.toString("latin1")).toContain("Quarterly Report Q1");
  });
});

describe("renderHtmlToPdf", () => {
  it("produces a non-empty PDF buffer with the %PDF- magic bytes header", async () => {
    const { buffer, contentLength } = await renderHtmlToPdf({
      template: "<h1>Invoice {{number}}</h1><p>Amount: <strong>{{amount}}</strong></p>",
      variables: { number: "INV-001", amount: "$100.00" },
    });
    expect(contentLength).toBeGreaterThan(500);
    expect(buffer.length).toBe(contentLength);
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders headings h1 through h6 without throwing", async () => {
    const html = "<h1>L1</h1><h2>L2</h2><h3>L3</h3><h4>L4</h4><h5>L5</h5><h6>L6</h6>";
    const { buffer } = await renderHtmlToPdf({ template: html });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("renders bulleted and ordered lists", async () => {
    const html = "<ul><li>alpha</li><li>beta</li></ul><ol><li>one</li><li>two</li></ol>";
    const { buffer } = await renderHtmlToPdf({ template: html });
    expect(buffer.subarray(0, 5).toString("latin1")).toBe("%PDF-");
  });

  it("rejects templates over the size cap", async () => {
    const huge = "<p>" + "x".repeat(200_001) + "</p>";
    await expect(renderHtmlToPdf({ template: huge })).rejects.toThrow(/exceeds/);
  });

  it("rejects templates whose variables expand beyond the size cap", async () => {
    const huge = "x".repeat(200_001);
    await expect(renderHtmlToPdf({
      template: "<p>{{payload}}</p>",
      variables: { payload: huge },
    })).rejects.toThrow(/exceeds/);
  });

  it("rejects nesting depth over the cap with a clear error", async () => {
    const open = "<div>".repeat(40);
    const close = "</div>".repeat(40);
    const html = open + "deep" + close;
    await expect(renderHtmlToPdf({ template: html })).rejects.toThrow(/nesting depth/);
  });
});

describe("parseAndSanitizeHtml — structural sanitization", () => {
  it("produces a heading block for h1-h6 with token-shaped content", () => {
    const blocks = parseAndSanitizeHtml("<h1>A</h1><h2>B</h2><h3>C</h3><h4>D</h4><h5>E</h5><h6>F</h6>");
    expect(blocks).toEqual([
      { kind: "heading", level: 1, tokens: [{ text: "A", style: "plain" }] },
      { kind: "heading", level: 2, tokens: [{ text: "B", style: "plain" }] },
      { kind: "heading", level: 3, tokens: [{ text: "C", style: "plain" }] },
      { kind: "heading", level: 4, tokens: [{ text: "D", style: "plain" }] },
      { kind: "heading", level: 5, tokens: [{ text: "E", style: "plain" }] },
      { kind: "heading", level: 6, tokens: [{ text: "F", style: "plain" }] },
    ]);
  });

  it("preserves an inline <a href> inside a heading as a link token", () => {
    const blocks = parseAndSanitizeHtml("<h1>Invoice <a href=\"https://x.com\">#42</a></h1>");
    expect(blocks).toHaveLength(1);
    const heading = blocks[0];
    if (heading.kind !== "heading") throw new Error("unreachable");
    expect(heading.tokens).toEqual([
      { text: "Invoice ", style: "plain" },
      { text: "#42", style: "link", href: "https://x.com" },
    ]);
  });

  it("preserves inline <strong> inside a heading as a bold token", () => {
    const blocks = parseAndSanitizeHtml("<h2>Total: <strong>$100</strong></h2>");
    expect(blocks).toHaveLength(1);
    const heading = blocks[0];
    if (heading.kind !== "heading") throw new Error("unreachable");
    expect(heading.tokens).toEqual([
      { text: "Total: ", style: "plain" },
      { text: "$100", style: "bold" },
    ]);
  });

  it("opens a new line inside <pre> when <br> appears, instead of escaping the pre block", () => {
    const blocks = parseAndSanitizeHtml("<pre>line1<br>line2</pre>");
    expect(blocks).toHaveLength(1);
    const code = blocks[0];
    if (code.kind !== "code") throw new Error("unreachable");
    expect(code.lines).toEqual(["line1", "line2"]);
  });

  it("rejects templates with > MAX_BLOCKS block elements", () => {
    // 6000 tiny paragraphs ~= 60KB, well under the 200KB byte cap, but
    // over the 5000-block cap. Should throw with a clear error.
    const html = "<p>x</p>".repeat(6000);
    expect(() => parseAndSanitizeHtml(html)).toThrow(/block elements/);
  });

  it("rejects templates with > MAX_TOKENS_PER_BLOCK inline tokens in a single block", () => {
    // 2500 <span> children with text — all collapse into ONE paragraph.
    // Each <span>x</span> contributes a token; first <span> opens the
    // implicit paragraph, subsequent spans land into it.
    const html = "<p>" + "<span>x</span>".repeat(2500) + "</p>";
    expect(() => parseAndSanitizeHtml(html)).toThrow(/inline tokens/);
  });

  it("emits a paragraph with inline strong/em tokens", () => {
    const blocks = parseAndSanitizeHtml("<p>Hi <strong>there</strong> <em>friend</em></p>");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      tokens: [
        { text: "Hi ", style: "plain" },
        { text: "there", style: "bold" },
        { text: " ", style: "plain" },
        { text: "friend", style: "italic" },
      ],
    });
  });

  it("emits bulleted and ordered list blocks", () => {
    const blocks = parseAndSanitizeHtml("<ul><li>a</li><li>b</li></ul><ol><li>1</li><li>2</li></ol>");
    expect(blocks).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [{ text: "a", style: "plain" }],
          [{ text: "b", style: "plain" }],
        ],
      },
      {
        kind: "list",
        ordered: true,
        items: [
          [{ text: "1", style: "plain" }],
          [{ text: "2", style: "plain" }],
        ],
      },
    ]);
  });

  it("emits a table block with header row + cell text", () => {
    const html = "<table><thead><tr><th>Item</th><th>Amount</th></tr></thead>"
      + "<tbody><tr><td>Widget</td><td>$10</td></tr><tr><td>Service</td><td>$20</td></tr></tbody></table>";
    const blocks = parseAndSanitizeHtml(html);
    expect(blocks).toHaveLength(1);
    const table = blocks[0];
    expect(table.kind).toBe("table");
    if (table.kind !== "table") throw new Error("unreachable");
    expect(table.headerRowCount).toBe(1);
    expect(table.rows).toHaveLength(3);
    expect(cellsText(table.rows[0])).toEqual(["Item", "Amount"]);
    expect(cellsText(table.rows[1])).toEqual(["Widget", "$10"]);
    expect(cellsText(table.rows[2])).toEqual(["Service", "$20"]);
    // Header cells flagged
    expect(table.rows[0].every((c) => c.isHeader)).toBe(true);
    expect(table.rows[1].every((c) => !c.isHeader)).toBe(true);
  });

  it("clamps colspan to [1, 16]", () => {
    const html = "<table><tr><td colspan=\"99\">wide</td></tr><tr><td colspan=\"-3\">neg</td></tr></table>";
    const blocks = parseAndSanitizeHtml(html);
    const t = blocks[0];
    if (t.kind !== "table") throw new Error("unreachable");
    expect(t.rows[0][0].colspan).toBe(16);
    expect(t.rows[1][0].colspan).toBe(1);
  });

  it("drops <script> content entirely", () => {
    const blocks = parseAndSanitizeHtml("<p>before</p><script>alert('xss')</script><p>after</p>");
    const concat = blocks.map(blockText).join(" | ");
    expect(concat).not.toContain("alert");
    expect(concat).not.toContain("xss");
    expect(concat).toContain("before");
    expect(concat).toContain("after");
  });

  it("drops <style> content entirely", () => {
    const blocks = parseAndSanitizeHtml("<p>before</p><style>.evil { color: red }</style><p>after</p>");
    const concat = blocks.map(blockText).join(" | ");
    expect(concat).not.toContain(".evil");
    expect(concat).toContain("before");
    expect(concat).toContain("after");
  });

  it("drops content inside non-void deny tags (script/style/iframe/object/form/svg)", () => {
    // Per HTML spec, `embed`/`link`/`meta`/`base`/`input`/`img` are VOID
    // elements with no children — htmlparser2 self-closes them, so any
    // following text is sibling content rather than the tag's body.
    // Those tags are exercised in the void-tag test below.
    const nonVoid = ["script", "style", "iframe", "object", "form", "svg"];
    for (const tag of nonVoid) {
      expect(HTML_DROP_TAGS_LIST).toContain(tag);
      const marker = `wrapper_${tag}_payload_unique`;
      const before = `before_${tag}`;
      const after = `after_${tag}`;
      const html = `<p>${before}</p><${tag}>${marker}</${tag}><p>${after}</p>`;
      const blocks = parseAndSanitizeHtml(html);
      const concat = blocks.map(blockText).join(" | ");
      expect(concat, `non-void drop-tag ${tag} should hide payload`).not.toContain(marker);
      expect(concat).toContain(before);
      expect(concat).toContain(after);
    }
  });

  it("renders surrounding content normally when void deny tags appear in line", () => {
    // Void elements (`embed`, `link`, `meta`, `base`, `input`, `img`) have no
    // body — there is no "inside" to drop. The walker just ignores the tag
    // itself; sibling text renders as if the tag weren't there.
    const voidTags = ["embed", "link", "meta", "base", "input", "img"];
    for (const tag of voidTags) {
      expect(HTML_DROP_TAGS_LIST).toContain(tag);
      const html = `<p>before_${tag}</p><${tag}><p>after_${tag}</p>`;
      const blocks = parseAndSanitizeHtml(html);
      const concat = blocks.map(blockText).join(" | ");
      expect(concat).toContain(`before_${tag}`);
      expect(concat).toContain(`after_${tag}`);
    }
  });

  it("drops on* event-handler attributes by emitting no attribute traces", () => {
    // The walker ignores attributes outside of `<a href>` and `<th/td colspan>`,
    // so an `onclick="..."` payload never reaches any Block. The content
    // inside the element renders normally.
    const blocks = parseAndSanitizeHtml("<p onclick=\"alert(1)\" onload=\"steal()\">hello</p>");
    expect(blocks).toEqual([
      { kind: "paragraph", tokens: [{ text: "hello", style: "plain" }] },
    ]);
  });

  it("drops javascript: hrefs and renders the anchor text as plain", () => {
    const blocks = parseAndSanitizeHtml("<p>See <a href=\"javascript:alert(1)\">phish</a> link</p>");
    expect(blocks).toHaveLength(1);
    const para = blocks[0];
    if (para.kind !== "paragraph") throw new Error("unreachable");
    // Every token must be a non-link style (no `style: "link"` survives).
    expect(para.tokens.every((t) => t.style !== "link")).toBe(true);
    expect(tokensText(para.tokens)).toContain("phish");
  });

  it("preserves https hrefs as link-style tokens", () => {
    const blocks = parseAndSanitizeHtml("<p>See <a href=\"https://janusly.com/docs\">docs</a></p>");
    const para = blocks[0];
    if (para.kind !== "paragraph") throw new Error("unreachable");
    const linkToken = para.tokens.find((t) => t.style === "link");
    expect(linkToken).toBeDefined();
    if (linkToken && linkToken.style === "link") {
      expect(linkToken.text).toBe("docs");
      expect(linkToken.href).toBe("https://janusly.com/docs");
    }
  });

  it("passes children through for unknown tags", () => {
    const blocks = parseAndSanitizeHtml("<p>start</p><customwidget>visible-payload</customwidget><p>end</p>");
    const concat = blocks.map(blockText).join(" | ");
    expect(concat).toContain("start");
    expect(concat).toContain("end");
    expect(concat).toContain("visible-payload");
  });

  it("collapses HTML whitespace runs to a single space", () => {
    const blocks = parseAndSanitizeHtml("<p>Hello   \n\n  world</p>");
    const para = blocks[0];
    if (para.kind !== "paragraph") throw new Error("unreachable");
    expect(tokensText(para.tokens)).toBe("Hello world");
  });

  it("handles <br> as an inline newline", () => {
    const blocks = parseAndSanitizeHtml("<p>line1<br>line2</p>");
    const para = blocks[0];
    if (para.kind !== "paragraph") throw new Error("unreachable");
    expect(tokensText(para.tokens)).toContain("line1");
    expect(tokensText(para.tokens)).toContain("line2");
  });

  it("substitutes variables before parsing", async () => {
    // Variable substitution happens in renderHtmlToPdf, not in parse;
    // here we go through the renderer's interpolation path explicitly.
    const html = substituteVariables("<p>Hello {{name}}, missing={{absent}}</p>", { name: "Ada" });
    const blocks = parseAndSanitizeHtml(html);
    const concat = blocks.map(blockText).join(" | ");
    expect(concat).toContain("Hello Ada");
    expect(concat).toContain("{{absent}}");
  });

  it("rejects nesting depth over the cap with a clear error", () => {
    const open = "<div>".repeat(40);
    const close = "</div>".repeat(40);
    expect(() => parseAndSanitizeHtml(open + "deep" + close)).toThrow(/nesting depth/);
  });
});
