package tools

import (
	"bytes"
	"testing"
)

// T-533: the PDF writers eat workflow-author templates — hostile input
// must yield a structurally valid PDF (header + EOF trailer), never a
// panic and never garbage output.
func pdfShapeOK(t *testing.T, document []byte, label string) {
	t.Helper()
	if !bytes.HasPrefix(document, []byte("%PDF-1.4")) {
		t.Fatalf("%s: output is not a PDF header: %.20q", label, document)
	}
	if !bytes.Contains(document, []byte("%%EOF")) {
		t.Fatalf("%s: output has no EOF trailer", label)
	}
}

func FuzzRenderMarkdownPDF(f *testing.F) {
	for _, seed := range []string{
		"# Hi\n\n**bold** *it*", "```\ncode\n```", "- a\n- b\n1. c",
		"---\n\n### deep", "((((((((", "\\\\", ")", "%%EOF injection",
		"# {{var}} placeholder", "snowman unicode\r\nwindows lines",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, template string) {
		if len(template) > 200_000 {
			return // the tool caps template size before rendering
		}
		pdfShapeOK(t, RenderMarkdownPDF(template), "markdown")
	})
}

func FuzzRenderHTMLPDF(f *testing.F) {
	for _, seed := range []string{
		"<h1>Hi</h1>", "<script>evil</script><p>after</p>",
		"<ul><li><ul><li>deep</li></ul></li></ul>", "<a href=\"javascript:x\">y</a>",
		"<table><tr><td>)</td></tr></table>", "<p unclosed", "<<<<>>>>",
		"<pre>%PDF-1.9 fake</pre>", "\xff broken",
	} {
		f.Add(seed)
	}
	f.Fuzz(func(t *testing.T, template string) {
		if len(template) > 200_000 {
			return
		}
		pdfShapeOK(t, RenderHTMLPDF(template), "html")
	})
}
