package tools

import (
	"strings"
	"testing"
)

// HTML dialect: the safe subset renders, the deny-set drops tag AND
// children with a VISIBLE marker, and hostile hrefs lose the link.

func TestRenderHTMLPDFSubset(t *testing.T) {
	pdf := string(RenderHTMLPDF(`
		<h1>Invoice INV-1</h1>
		<p>Total <strong>$100</strong> for <em>May</em></p>
		<ul><li>alpha</li><li>beta</li></ul>
		<ol><li>first</li><li>second</li></ol>
		<table><tr><th>Item</th><th>Qty</th></tr><tr><td>Widget</td><td>3</td></tr></table>
		<pre>code line</pre>
		<a href="https://example.com/doc">the doc</a>`))
	for _, want := range []string{
		"Invoice INV-1", "Total $100 for May",
		"alpha", "1.  first", "2.  second",
		"Item | Qty", "Widget | 3", "code line",
		`the doc \(https://example.com/doc\)`,
	} {
		if !strings.Contains(pdf, want) {
			t.Fatalf("rendered pdf missing %q", want)
		}
	}
}

func TestRenderHTMLPDFSanitization(t *testing.T) {
	pdf := string(RenderHTMLPDF(`
		<p>before</p>
		<script>alert("stolen secrets")</script>
		<img src="http://evil.example/x.png">
		<p onclick="evil()">after</p>
		<a href="javascript:alert(1)">click me</a>`))
	if strings.Contains(pdf, "stolen secrets") || strings.Contains(pdf, "alert") {
		t.Fatal("script content must die with the tag")
	}
	if strings.Contains(pdf, "evil.example") {
		t.Fatal("img must be dropped whole")
	}
	if !strings.Contains(pdf, "[removed: <script>]") || !strings.Contains(pdf, "[removed: <img>]") {
		t.Fatal("the drop must be VISIBLE in the document")
	}
	if !strings.Contains(pdf, "before") || !strings.Contains(pdf, "after") {
		t.Fatal("safe content must survive around the drops")
	}
	if strings.Contains(pdf, "javascript:") {
		t.Fatal("javascript: href must be stripped")
	}
	if !strings.Contains(pdf, "click me") {
		t.Fatal("anchor text must render plain when the href is hostile")
	}
	unknown := string(RenderHTMLPDF(`<article><p>inside unknown</p></article>`))
	if !strings.Contains(unknown, "inside unknown") {
		t.Fatal("unknown tags must pass children through")
	}
}

func TestRenderHTMLPDFCoalescedText(t *testing.T) {
	// Ignored end tags keep appending to the same text node. This bounded
	// template exercises the parser's GO-2026-6860 quadratic-copying case.
	const runs = 10_000
	input := "<p>" + strings.Repeat("a</x>", runs) + "</p>"
	pdf := RenderHTMLPDF(input)
	pdfShapeOK(t, pdf, "coalesced html")
	if !strings.Contains(string(pdf), strings.Repeat("a", runs)) {
		t.Fatal("coalesced text must survive HTML rendering")
	}

	// Measure bytes rather than elapsed time so host load cannot decide the
	// result. The old parser copies about 50 MB for this 50 KB template;
	// leave generous headroom for linear parser and PDF-writer allocations.
	result := testing.Benchmark(func(b *testing.B) {
		for b.Loop() {
			RenderHTMLPDF(input)
		}
	})
	allocated := result.AllocedBytesPerOp()
	t.Logf("coalesced HTML: %d bytes allocated per render", allocated)
	if allocated > 16<<20 {
		t.Fatalf("coalesced HTML allocated %d bytes per render, limit %d", allocated, 16<<20)
	}
}
