// pdf.generate — the Markdown-subset PDF tool. The runtime ships its own
// dependency-free PDF 1.4 writer (Helvetica base fonts, multi-page line
// layout) over the contract's markdown subset: headings 1-3, paragraphs
// with **bold** / *italic* runs (rendered via font switching), bulleted
// and numbered lists, fenced code blocks (Courier), and --- rules.
// `{{name}}` placeholders substitute BEFORE parsing; unknown ones stay
// visible on purpose (operators see the typo, not an empty cell). The
// artifact lands in the object store under the caller-assembled per-org
// key; the envelope NEVER throws. The HTML dialect lives in
// pdfhtml.go; markdown stays the default format.
package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/johnny4young/janusly/internal/objectstore"
)

const (
	pdfTemplateMax         = 200_000
	pdfVariablesMax        = 50
	pdfVariableValueMax    = 16 << 10
	pdfVariablesPayloadMax = 64 << 10
	pdfExpandedTemplateMax = 1 << 20
	pdfFilenameMaxRunes    = 128
	pdfFilenameMaxBytes    = 512
)

// PdfKeyBuilder assembles the tenant-scoped object key (engine seam).
type PdfKeyBuilder func(filename string) string

func validatePDFFilename(filename string) error {
	if filename == "" || filename != strings.TrimSpace(filename) || filename == "." || filename == ".." ||
		strings.Contains(filename, "..") || strings.ContainsAny(filename, `/\\`) ||
		len(filename) > pdfFilenameMaxBytes || utf8.RuneCountInString(filename) > pdfFilenameMaxRunes {
		return fmt.Errorf("filename must be a safe base name of at most %d characters", pdfFilenameMaxRunes)
	}
	for _, character := range filename {
		if unicode.IsControl(character) {
			return fmt.Errorf("filename must not contain control characters")
		}
	}
	return nil
}

func pdfVariableString(value any) (string, bool) {
	switch typed := value.(type) {
	case string:
		return typed, true
	case bool:
		return strconv.FormatBool(typed), true
	case int:
		return strconv.FormatInt(int64(typed), 10), true
	case int8:
		return strconv.FormatInt(int64(typed), 10), true
	case int16:
		return strconv.FormatInt(int64(typed), 10), true
	case int32:
		return strconv.FormatInt(int64(typed), 10), true
	case int64:
		return strconv.FormatInt(typed, 10), true
	case uint:
		return strconv.FormatUint(uint64(typed), 10), true
	case uint8:
		return strconv.FormatUint(uint64(typed), 10), true
	case uint16:
		return strconv.FormatUint(uint64(typed), 10), true
	case uint32:
		return strconv.FormatUint(uint64(typed), 10), true
	case uint64:
		return strconv.FormatUint(typed, 10), true
	case float32:
		value := float64(typed)
		if math.IsNaN(value) || math.IsInf(value, 0) {
			return "", false
		}
		return strconv.FormatFloat(value, 'g', -1, 32), true
	case float64:
		if math.IsNaN(typed) || math.IsInf(typed, 0) {
			return "", false
		}
		return strconv.FormatFloat(typed, 'g', -1, 64), true
	case json.Number:
		if !validJSONNumber(typed) {
			return "", false
		}
		return typed.String(), true
	default:
		return "", false
	}
}

func normalizePDFVariables(raw any) (map[string]string, error) {
	if raw == nil {
		return map[string]string{}, nil
	}
	rawVariables, ok := raw.(map[string]any)
	if !ok || len(rawVariables) > pdfVariablesMax {
		return nil, fmt.Errorf("variables must be an object with at most %d entries", pdfVariablesMax)
	}
	serialized, err := json.Marshal(rawVariables)
	if err != nil || len(serialized) > pdfVariablesPayloadMax {
		return nil, fmt.Errorf("variables exceed %d bytes", pdfVariablesPayloadMax)
	}
	variables := make(map[string]string, len(rawVariables))
	for key, rawValue := range rawVariables {
		if !placeholderNamePattern.MatchString(key) {
			return nil, fmt.Errorf("variable names must match %s", placeholderNamePattern.String())
		}
		value, valid := pdfVariableString(rawValue)
		if !valid || len(value) > pdfVariableValueMax {
			return nil, fmt.Errorf("variable values must be bounded JSON scalar values")
		}
		variables[key] = value
	}
	return variables, nil
}

func validatePDFInput(input map[string]any, options InputValidationOptions) error {
	templateRaw, templatePresent := input["template"]
	templateDeferred := templatePresent && isDeferredWholeTemplate(templateRaw, options)
	if templatePresent && !templateDeferred {
		template := templateRaw.(string)
		if strings.TrimSpace(template) == "" || len(template) > pdfTemplateMax {
			return fmt.Errorf("template must be non-empty and at most %d bytes", pdfTemplateMax)
		}
	}
	if raw, present := input["format"]; present && !isDeferredWholeTemplate(raw, options) {
		format := raw.(string)
		if format != "markdown" && format != "html" {
			return fmt.Errorf("format must be markdown or html")
		}
	}
	if raw, present := input["filename"]; present && !isDeferredWholeTemplate(raw, options) {
		if err := validatePDFFilename(raw.(string)); err != nil {
			return err
		}
	}
	variablesRaw, variablesPresent := input["variables"]
	variablesDeferred := variablesPresent && isDeferredWholeTemplate(variablesRaw, options)
	variables := map[string]string{}
	if variablesPresent && !variablesDeferred {
		var err error
		variables, err = normalizePDFVariables(variablesRaw)
		if err != nil {
			return err
		}
	}
	if templatePresent && !templateDeferred && !variablesDeferred {
		if _, ok := substitutePDFVariablesBounded(templateRaw.(string), variables, pdfExpandedTemplateMax); !ok {
			return fmt.Errorf("expanded template exceeds %d bytes", pdfExpandedTemplateMax)
		}
	}
	return nil
}

func pdfTools() []Definition {
	unavailable := func(_ context.Context, _ map[string]any) (map[string]any, error) {
		return map[string]any{"ok": false, "provider": "noop", "error": "integration tools require run context"}, nil
	}
	return []Definition{{
		Name:        "pdf.generate",
		Description: "Render a Markdown template to a PDF and store it in the object store.",
		Required:    []string{"template"},
		Optional:    []string{"format", "variables", "filename"},
		Fields: []Field{
			{Name: "template", Type: "string", Required: true},
			{Name: "format", Type: "string"},
			{Name: "variables", Type: "object"},
			{Name: "filename", Type: "string"},
		},
		InputExample: map[string]any{
			"format": "markdown", "template": "# Invoice {{number}}\n\nAmount: **{{amount}}**",
			"variables": map[string]any{"number": "INV-001", "amount": "$100.00"},
			"filename":  "invoice.pdf",
		},
		Validate:  validatePDFInput,
		WriteSide: true,
		Execute:   unavailable,
	}}
}

var (
	placeholderNamePattern = regexp.MustCompile(`^[A-Za-z0-9_]{1,64}$`)
	placeholderPattern     = regexp.MustCompile(`\{\{([A-Za-z0-9_]{1,64})\}\}`)
)

func substitutePDFVariablesBounded(template string, variables map[string]string, maximum int) (string, bool) {
	locations := placeholderPattern.FindAllStringSubmatchIndex(template, -1)
	if len(locations) == 0 {
		return template, len(template) <= maximum
	}
	var out strings.Builder
	out.Grow(min(len(template), maximum))
	last := 0
	appendBounded := func(value string) bool {
		if len(value) > maximum-out.Len() {
			return false
		}
		out.WriteString(value)
		return true
	}
	for _, location := range locations {
		if !appendBounded(template[last:location[0]]) {
			return "", false
		}
		name := template[location[2]:location[3]]
		replacement, known := variables[name]
		if !known {
			replacement = template[location[0]:location[1]]
		}
		if !appendBounded(replacement) {
			return "", false
		}
		last = location[1]
	}
	if !appendBounded(template[last:]) {
		return "", false
	}
	return out.String(), true
}

// SubstituteVariables replaces known {{name}} placeholders; unknown ones
// stay intact (the contract's visible-typo posture).
func SubstituteVariables(template string, variables map[string]string) string {
	// Kept as the public pure helper for callers and compatibility tests. The
	// executable path below applies the hard expansion ceiling.
	return placeholderPattern.ReplaceAllStringFunc(template, func(match string) string {
		name := placeholderPattern.FindStringSubmatch(match)[1]
		if value, known := variables[name]; known {
			return value
		}
		return match
	})
}

// executePdfGenerate runs the tool through the chokepoint deps.
func executePdfGenerate(ctx context.Context, input map[string]any, deps *IntegrationDeps) map[string]any {
	start := time.Now()
	template, _ := input["template"].(string)
	format, _ := input["format"].(string)
	if template == "" || len(template) > pdfTemplateMax {
		return map[string]any{"ok": false, "provider": "noop", "error": "pdf.generate requires template (≤200000 chars)"}
	}
	if format != "" && format != "markdown" && format != "html" {
		return map[string]any{"ok": false, "provider": "noop",
			"error": "pdf.generate format \"" + format + "\" is not supported (markdown or html)"}
	}
	variables, variablesError := normalizePDFVariables(input["variables"])
	if variablesError != nil {
		return map[string]any{"ok": false, "provider": "noop", "error": variablesError.Error()}
	}
	filename, _ := input["filename"].(string)
	// The filename is WORKFLOW-AUTHOR input feeding an object key: keep
	// only the last path segment and refuse dot-segments so it can never
	// climb out of the tenant prefix the engine assembles.
	if slash := strings.LastIndexAny(filename, "/\\"); slash >= 0 {
		filename = filename[slash+1:]
	}
	filename = strings.ReplaceAll(filename, "..", "")
	if filename == "" || filename == ".pdf" {
		filename = "document.pdf"
	}
	if !strings.HasSuffix(strings.ToLower(filename), ".pdf") {
		filename += ".pdf"
	}
	record := func(provider string, ok bool, errMessage string) {
		if deps != nil && deps.Record != nil {
			deps.Record("pdf.generate", "", ok, 0, errMessage, int(time.Since(start).Milliseconds()))
		}
		_ = provider
	}
	if deps != nil && deps.RateLimit != nil {
		rateLimit := 60
		if deps.RateLimitPerMin != nil {
			rateLimit = deps.RateLimitPerMin("pdf", 60)
		}
		if errMessage := deps.RateLimit(ctx, "pdf.generate", rateLimit); errMessage != "" {
			record("noop", false, errMessage)
			return map[string]any{"ok": false, "provider": "noop", "error": errMessage}
		}
	}

	substituted, withinLimit := substitutePDFVariablesBounded(template, variables, pdfExpandedTemplateMax)
	if !withinLimit {
		return map[string]any{"ok": false, "provider": "noop", "error": "pdf.generate expanded template exceeds the size cap"}
	}
	var document []byte
	if format == "html" {
		document = RenderHTMLPDF(substituted)
	} else {
		document = RenderMarkdownPDF(substituted)
	}
	key := "pdf/" + filename
	if deps != nil && deps.PdfKey != nil {
		key = deps.PdfKey(filename)
	}
	result := objectstore.Put(ctx, "", key, document, "application/pdf")
	if !result.Ok {
		record(result.Provider, false, result.Error)
		return map[string]any{"ok": false, "provider": result.Provider, "error": result.Error}
	}
	record(result.Provider, true, "")
	return map[string]any{
		"ok": true, "provider": result.Provider, "url": result.URL,
		"key": result.Key, "bytes": len(document),
	}
}

/* ------------------------- minimal PDF writer ------------------------- */

type pdfLine struct {
	text string
	font string // F1 regular, F2 bold, F3 italic, F4 mono
	size float64
}

var (
	boldPattern = regexp.MustCompile(`\*\*([^*]+)\*\*`)
	// Numbered-list marker: hoisted here because it sits in a per-line
	// switch and used to be compiled (twice) for every matching line.
	numberedListPattern = regexp.MustCompile(`^\d+\. `)
	italicPattern       = regexp.MustCompile(`\*([^*]+)\*`)
)

// RenderMarkdownPDF renders the markdown subset into a PDF 1.4 document.
// Line-level styling: a heading renders bold at its level size; a
// paragraph whose whole text is bold/italic switches font; inline mixed
// runs render with markers stripped (bounded fidelity, documented).
func RenderMarkdownPDF(markdown string) []byte {
	lines := []pdfLine{}
	push := func(text, font string, size float64) {
		for _, wrapped := range wrapText(text, int(510/(size*0.5))) {
			lines = append(lines, pdfLine{text: wrapped, font: font, size: size})
		}
	}
	inCode := false
	listIndex := 0
	for raw := range strings.SplitSeq(markdown, "\n") {
		line := strings.TrimRight(raw, " \t")
		switch {
		case strings.HasPrefix(line, "```"):
			inCode = !inCode
			listIndex = 0
		case inCode:
			lines = append(lines, pdfLine{text: raw, font: "F4", size: 9})
		case strings.HasPrefix(line, "### "):
			push(stripInline(strings.TrimPrefix(line, "### ")), "F2", 12)
			listIndex = 0
		case strings.HasPrefix(line, "## "):
			push(stripInline(strings.TrimPrefix(line, "## ")), "F2", 14)
			listIndex = 0
		case strings.HasPrefix(line, "# "):
			push(stripInline(strings.TrimPrefix(line, "# ")), "F2", 18)
			listIndex = 0
		case line == "---":
			lines = append(lines, pdfLine{text: strings.Repeat("_", 70), font: "F1", size: 8})
			listIndex = 0
		case strings.HasPrefix(line, "- ") || strings.HasPrefix(line, "* "):
			push("•  "+stripInline(line[2:]), "F1", 11)
		case numberedListPattern.MatchString(line):
			listIndex++
			push(fmt.Sprintf("%d.  %s", listIndex, stripInline(numberedListPattern.ReplaceAllString(line, ""))), "F1", 11)
		case line == "":
			lines = append(lines, pdfLine{text: "", font: "F1", size: 11})
			listIndex = 0
		default:
			font := "F1"
			if boldPattern.MatchString(line) && boldPattern.ReplaceAllString(line, "") == "" {
				font = "F2"
			} else if italicPattern.MatchString(line) && italicPattern.ReplaceAllString(line, "") == "" {
				font = "F3"
			}
			push(stripInline(line), font, 11)
			listIndex = 0
		}
	}
	return buildPDF(lines)
}

func stripInline(text string) string {
	text = boldPattern.ReplaceAllString(text, "$1")
	return italicPattern.ReplaceAllString(text, "$1")
}

func wrapText(text string, width int) []string {
	if width < 20 {
		width = 20
	}
	if len(text) <= width {
		return []string{text}
	}
	words := strings.Fields(text)
	wrapped, current := []string{}, ""
	for _, word := range words {
		if current == "" {
			current = word
		} else if len(current)+1+len(word) <= width {
			current += " " + word
		} else {
			wrapped = append(wrapped, current)
			current = word
		}
	}
	if current != "" {
		wrapped = append(wrapped, current)
	}
	if len(wrapped) == 0 {
		return []string{""}
	}
	return wrapped
}

func escapePDFText(text string) string {
	replacer := strings.NewReplacer("\\", "\\\\", "(", "\\(", ")", "\\)")
	return replacer.Replace(text)
}

// buildPDF assembles a multi-page PDF 1.4 with four base-14 fonts.
func buildPDF(lines []pdfLine) []byte {
	const pageHeight, topMargin, bottomMargin = 792.0, 760.0, 40.0
	type page struct{ content bytes.Buffer }
	pages := []*page{}
	current := &page{}
	pages = append(pages, current)
	cursor := topMargin
	for _, line := range lines {
		lineHeight := line.size * 1.45
		if cursor-lineHeight < bottomMargin {
			current = &page{}
			pages = append(pages, current)
			cursor = topMargin
		}
		cursor -= lineHeight
		if line.text == "" {
			continue
		}
		fmt.Fprintf(&current.content, "BT /%s %.1f Tf 50 %.1f Td (%s) Tj ET\n",
			line.font, line.size, cursor, escapePDFText(line.text))
	}

	var out bytes.Buffer
	offsets := []int{}
	writeObject := func(body string) {
		offsets = append(offsets, out.Len())
		fmt.Fprintf(&out, "%d 0 obj\n%s\nendobj\n", len(offsets), body)
	}
	out.WriteString("%PDF-1.4\n")
	// 1 catalog, 2 pages, 3..6 fonts, then per page: content + page objs.
	fonts := map[string]string{"F1": "Helvetica", "F2": "Helvetica-Bold", "F3": "Helvetica-Oblique", "F4": "Courier"}
	pageObjectIDs := []int{}
	firstPageObject := 6 + 1
	for i := range pages {
		pageObjectIDs = append(pageObjectIDs, firstPageObject+i*2+1)
	}
	kids := make([]string, 0, len(pageObjectIDs))
	for _, id := range pageObjectIDs {
		kids = append(kids, fmt.Sprintf("%d 0 R", id))
	}
	writeObject("<< /Type /Catalog /Pages 2 0 R >>")
	writeObject(fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), len(pages)))
	for _, fontKey := range []string{"F1", "F2", "F3", "F4"} {
		writeObject(fmt.Sprintf("<< /Type /Font /Subtype /Type1 /BaseFont /%s >>", fonts[fontKey]))
	}
	for i, pg := range pages {
		content := pg.content.String()
		writeObject(fmt.Sprintf("<< /Length %d >>\nstream\n%sendstream", len(content), content))
		writeObject(fmt.Sprintf(
			"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents %d 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >> >> >>",
			firstPageObject+i*2))
	}
	xrefOffset := out.Len()
	fmt.Fprintf(&out, "xref\n0 %d\n0000000000 65535 f \n", len(offsets)+1)
	for _, offset := range offsets {
		fmt.Fprintf(&out, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&out, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets)+1, xrefOffset)
	return out.Bytes()
}
