/**
 * Tests for the Markdown → PDF renderer used by the `pdf.generate` tool.
 * Asserts the variable-substitution contract (unknown placeholders left
 * intact so operators see typos), the PDF magic-bytes header, and the
 * size cap.
 */
import { describe, expect, it } from "vitest";

import { renderMarkdownToPdf, substituteVariables } from "./pdf-renderer";

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
