package tools

import (
	"bytes"
	"context"
	"os"
	"strings"
	"testing"
)

// The renderer emits a structurally valid multi-page PDF: header, xref,
// every markdown block class represented, and parens escaped.
func TestRenderMarkdownPDF(t *testing.T) {
	markdown := "# Title\n\n## Section\n\nPlain paragraph with (parens).\n\n" +
		"**All bold line**\n\n- item one\n- item two\n1. first\n2. second\n\n---\n\n" +
		"```\ncode line\n```\n"
	document := RenderMarkdownPDF(markdown)
	text := string(document)
	if !strings.HasPrefix(text, "%PDF-1.4") || !strings.Contains(text, "startxref") ||
		!strings.Contains(text, "%%EOF") {
		t.Fatalf("PDF skeleton missing")
	}
	for _, needle := range []string{"(Title)", "(Section)", "\\(parens\\)", "(All bold line)", "/F2", "/F4", "(code line)"} {
		if !strings.Contains(text, needle) {
			t.Fatalf("missing %q in PDF content", needle)
		}
	}
	// A long document paginates: > 1 page object.
	long := RenderMarkdownPDF(strings.Repeat("paragraph line\n\n", 200))
	if pages := bytes.Count(long, []byte("/Type /Page ")); pages < 2 {
		t.Fatalf("long document must paginate: %d pages", pages)
	}
}

// Substitution: known placeholders replace, unknown stay VISIBLE.
func TestSubstituteVariables(t *testing.T) {
	out := SubstituteVariables("# Invoice {{number}} for {{customer}}", map[string]string{"number": "INV-1"})
	if out != "# Invoice INV-1 for {{customer}}" {
		t.Fatalf("substitution: %q", out)
	}
}

// The tool envelope: local object store round-trip, per-org key via the
// seam, html format refused honestly, noop store fails closed.
func TestPdfGenerateEnvelope(t *testing.T) {
	ctx := context.Background()
	deps := &IntegrationDeps{
		Gate:      func(context.Context, string, string, string, int) (string, string) { return "", "" },
		Post:      func(context.Context, string, map[string]string, []byte) (int, string, string) { return 0, "", "" },
		RateLimit: func(context.Context, string, int) string { return "" },
		PdfKey:    func(filename string) string { return "orgs/org-t/pdf/fixed/" + filename },
	}
	// Unconfigured store → noop envelope.
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "")
	result := ExecuteIntegrationTool(ctx, "pdf.generate", map[string]any{"template": "# Hi"}, deps)
	if result["ok"] != false || !strings.Contains(result["error"].(string), "Object store not configured") {
		t.Fatalf("noop store: %+v", result)
	}
	// html dialect refused honestly.
	result = ExecuteIntegrationTool(ctx, "pdf.generate", map[string]any{
		"template": "<h1>Hi</h1>", "format": "html",
	}, deps)
	if result["ok"] != false || !strings.Contains(result["error"].(string), "not supported") {
		t.Fatalf("html refuse: %+v", result)
	}
	// Local provider round-trip with the tenant key.
	root := t.TempDir()
	t.Setenv("JANUSLY_OBJECT_STORE_PROVIDER", "local")
	t.Setenv("JANUSLY_OBJECT_STORE_LOCAL_DIR", root)
	result = ExecuteIntegrationTool(ctx, "pdf.generate", map[string]any{
		"template": "# Invoice {{number}}", "variables": map[string]any{"number": "INV-9"},
		"filename": "invoice.pdf",
	}, deps)
	if result["ok"] != true || result["provider"] != "local" {
		t.Fatalf("local store: %+v", result)
	}
	stored, err := os.ReadFile(root + "/orgs/org-t/pdf/fixed/invoice.pdf")
	if err != nil || !strings.Contains(string(stored), "(Invoice INV-9)") {
		t.Fatalf("stored artifact: %v", err)
	}
	// A hostile FILENAME (workflow-author input) cannot climb out of the
	// tenant prefix: only its last segment survives, dot-segments drop.
	deps.PdfKey = func(filename string) string { return "orgs/org-t/pdf/fixed/" + filename }
	result = ExecuteIntegrationTool(ctx, "pdf.generate", map[string]any{
		"template": "# X", "filename": "../../evil/escape.pdf",
	}, deps)
	if result["ok"] != true || !strings.HasPrefix(result["key"].(string), "orgs/org-t/pdf/fixed/") ||
		strings.Contains(result["key"].(string), "..") {
		t.Fatalf("hostile filename must stay under the tenant prefix: %+v", result)
	}
	if _, err := os.Stat(root + "/evil"); err == nil {
		t.Fatal("traversal escaped the tenant prefix")
	}
}
