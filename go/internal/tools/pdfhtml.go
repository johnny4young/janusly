// The pdf.generate HTML dialect (T-521; reference pdf-renderer.ts): a
// closed, sanitized subset parsed with golang.org/x/net/html and mapped
// onto the SAME pdfLine blocks the markdown renderer feeds the writer.
//
// Whitelist: h1-h6, p, div, br, ul, ol, li, hr, pre, code, strong/b,
// em/i, span, a[href http/https only], table/thead/tbody/tr/th/td.
// Deny-set (tag AND children dropped): script, style, iframe, object,
// embed, link, meta, base, form, input, img, svg — and the drop is
// VISIBLE: a "[removed: <tag>]" marker line lands in the PDF so an
// operator sees the degradation instead of silently losing content.
// Unknown tags pass children through. on* handlers and style attributes
// never survive (only href is ever read). javascript: hrefs drop the
// href and render the anchor text plain.
package tools

import (
	"fmt"
	"strings"

	"golang.org/x/net/html"
)

var pdfHTMLDropTags = map[string]bool{
	"script": true, "style": true, "iframe": true, "object": true,
	"embed": true, "link": true, "meta": true, "base": true,
	"form": true, "input": true, "img": true, "svg": true,
}

var pdfHTMLHeadingSizes = map[string]float64{
	"h1": 18, "h2": 14, "h3": 12, "h4": 11, "h5": 11, "h6": 11,
}

const pdfHTMLMaxDepth = 50

// RenderHTMLPDF renders the sanitized HTML subset into a PDF document.
func RenderHTMLPDF(input string) []byte {
	root, err := html.Parse(strings.NewReader(input))
	if err != nil {
		return buildPDF([]pdfLine{{text: "[invalid html template]", font: "F1", size: 11}})
	}
	renderer := &htmlPdfRenderer{}
	renderer.walk(root, 0)
	renderer.flush("F1", 11)
	if len(renderer.lines) == 0 {
		renderer.lines = []pdfLine{{text: "", font: "F1", size: 11}}
	}
	return buildPDF(renderer.lines)
}

type htmlPdfRenderer struct {
	lines     []pdfLine
	current   strings.Builder
	listDepth int
	orderedAt []int // per-depth ordered-list counters; 0 = bulleted
	inPre     bool
}

func (r *htmlPdfRenderer) push(text, font string, size float64) {
	for _, wrapped := range wrapText(text, int(510/(size*0.5))) {
		r.lines = append(r.lines, pdfLine{text: wrapped, font: font, size: size})
	}
}

// flush emits the accumulated inline text as one block line.
func (r *htmlPdfRenderer) flush(font string, size float64) {
	text := strings.Join(strings.Fields(r.current.String()), " ")
	r.current.Reset()
	if text == "" {
		return
	}
	if r.listDepth > 0 {
		marker := "•  "
		if len(r.orderedAt) >= r.listDepth && r.orderedAt[r.listDepth-1] > 0 {
			marker = fmt.Sprintf("%d.  ", r.orderedAt[r.listDepth-1])
		}
		text = strings.Repeat("   ", r.listDepth-1) + marker + text
	}
	r.push(text, font, size)
}

func (r *htmlPdfRenderer) walk(node *html.Node, depth int) {
	if depth > pdfHTMLMaxDepth {
		return
	}
	switch node.Type {
	case html.TextNode:
		if r.inPre {
			for line := range strings.SplitSeq(node.Data, "\n") {
				if strings.TrimSpace(line) != "" {
					r.lines = append(r.lines, pdfLine{text: line, font: "F4", size: 9})
				}
			}
		} else {
			r.current.WriteString(node.Data)
		}
		return
	case html.ElementNode:
		tag := strings.ToLower(node.Data)
		if pdfHTMLDropTags[tag] {
			// Visible degradation: the operator sees WHAT was removed.
			r.flush("F1", 11)
			r.push("[removed: <"+tag+">]", "F3", 9)
			return // children die with the tag
		}
		switch tag {
		case "h1", "h2", "h3", "h4", "h5", "h6":
			r.flush("F1", 11)
			r.walkChildren(node, depth)
			r.flush("F2", pdfHTMLHeadingSizes[tag])
			return
		case "p", "div":
			r.flush("F1", 11)
			r.walkChildren(node, depth)
			r.flush("F1", 11)
			return
		case "br":
			r.flush("F1", 11)
			return
		case "hr":
			r.flush("F1", 11)
			r.lines = append(r.lines, pdfLine{text: strings.Repeat("_", 70), font: "F1", size: 8})
			return
		case "pre":
			r.flush("F1", 11)
			r.inPre = true
			r.walkChildren(node, depth)
			r.inPre = false
			return
		case "ul", "ol":
			r.flush("F1", 11)
			r.listDepth++
			if len(r.orderedAt) < r.listDepth {
				r.orderedAt = append(r.orderedAt, 0)
			}
			if tag == "ol" {
				r.orderedAt[r.listDepth-1] = 0 // becomes 1 on the first <li>
			} else {
				r.orderedAt[r.listDepth-1] = -1 // bullet marker
			}
			r.walkChildren(node, depth)
			r.orderedAt = r.orderedAt[:r.listDepth-1]
			r.listDepth--
			return
		case "li":
			if r.listDepth > 0 && r.orderedAt[r.listDepth-1] >= 0 {
				r.orderedAt[r.listDepth-1]++
			}
			r.walkChildren(node, depth)
			r.flush("F1", 11)
			return
		case "strong", "b":
			r.walkChildren(node, depth)
			return
		case "em", "i", "span", "code", "thead", "tbody":
			r.walkChildren(node, depth)
			return
		case "a":
			href := ""
			for _, attr := range node.Attr {
				if strings.ToLower(attr.Key) == "href" {
					candidate := strings.TrimSpace(attr.Val)
					lower := strings.ToLower(candidate)
					if strings.HasPrefix(lower, "http://") || strings.HasPrefix(lower, "https://") {
						href = candidate
					}
				}
			}
			r.walkChildren(node, depth)
			if href != "" {
				r.current.WriteString(" (" + href + ")")
			}
			return
		case "table":
			r.flush("F1", 11)
			r.walkChildren(node, depth)
			return
		case "tr":
			cells := []string{}
			for cell := node.FirstChild; cell != nil; cell = cell.NextSibling {
				if cell.Type != html.ElementNode {
					continue
				}
				cellTag := strings.ToLower(cell.Data)
				if cellTag != "td" && cellTag != "th" {
					continue
				}
				nested := &htmlPdfRenderer{}
				nested.walkChildren(cell, depth+1)
				cells = append(cells, strings.Join(strings.Fields(nested.current.String()), " "))
			}
			r.push(strings.Join(cells, " | "), "F1", 10)
			return
		}
		// Unknown tag: children pass through (reference posture).
		r.walkChildren(node, depth)
		return
	default:
		r.walkChildren(node, depth)
	}
}

func (r *htmlPdfRenderer) walkChildren(node *html.Node, depth int) {
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		r.walk(child, depth+1)
	}
}
