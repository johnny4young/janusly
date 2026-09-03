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
	// Unknown dialects are refused honestly; HTML is explicitly supported.
	result = ExecuteIntegrationTool(ctx, "pdf.generate", map[string]any{
		"template": "x", "format": "docx",
	}, deps)
	if result["ok"] != false || !strings.Contains(result["error"].(string), "markdown or html") {
		t.Fatalf("unknown format refuse: %+v", result)
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
	// A hostile filename is rejected at the shared semantic boundary rather
	// than being silently rewritten into a different artifact name.
	deps.PdfKey = func(filename string) string { return "orgs/org-t/pdf/fixed/" + filename }
	result = ExecuteIntegrationTool(ctx, "pdf.generate", map[string]any{
		"template": "# X", "filename": "../../evil/escape.pdf",
	}, deps)
	if result["ok"] != false || !strings.Contains(result["error"].(string), "safe base name") {
		t.Fatalf("hostile filename must fail before storage: %+v", result)
	}
	if _, err := os.Stat(root + "/evil"); err == nil {
		t.Fatal("traversal escaped the tenant prefix")
	}
}

func TestPdfInputContractBoundsExpansionAndVariables(t *testing.T) {
	registry := NewRegistry()
	if err := registry.ValidatePartialInput("pdf.generate", map[string]any{
		"variables": "{{context.prepare.output.variables}}",
	}); err != nil {
		t.Fatalf("an incomplete proposal may defer the variables binding: %v", err)
	}
	if err := registry.ValidateInput("pdf.generate", map[string]any{
		"template": "# Invoice {{number}}", "variables": map[string]any{"number": 42},
		"filename": "invoice.PDF",
	}); err != nil {
		t.Fatalf("bounded scalar variables should validate: %v", err)
	}

	tests := []struct {
		name    string
		input   map[string]any
		message string
	}{
		{name: "empty template", input: map[string]any{"template": "   "}, message: "template must be non-empty"},
		{name: "unknown format", input: map[string]any{"template": "x", "format": "docx"}, message: "markdown or html"},
		{name: "nested variable", input: map[string]any{"template": "{{x}}", "variables": map[string]any{"x": map[string]any{"secret": true}}}, message: "bounded JSON scalar"},
		{name: "invalid variable name", input: map[string]any{"template": "x", "variables": map[string]any{"bad.name": "x"}}, message: "variable names"},
		{name: "unsafe filename", input: map[string]any{"template": "x", "filename": `dir\\report.pdf`}, message: "safe base name"},
		{name: "amplified template", input: map[string]any{
			"template": strings.Repeat("{{x}}", 65), "variables": map[string]any{"x": strings.Repeat("z", pdfVariableValueMax)},
		}, message: "expanded template exceeds"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := registry.ValidateInput("pdf.generate", test.input)
			if err == nil || !strings.Contains(err.Error(), test.message) {
				t.Fatalf("expected %q rejection, got %v", test.message, err)
			}
		})
	}
}
