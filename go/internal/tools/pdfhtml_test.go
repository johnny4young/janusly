package tools

import (
	"strings"
	"testing"
)

// T-521 HTML dialect: the safe subset renders, the deny-set drops tag AND
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
