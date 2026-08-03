// AI evidence side-channel ("Why this suggestion?"), ported from the
// reference's shared ai-evidence module: a DETERMINISTIC projection of
// the context the prompt composer already gathered, emitted as a
// structured response field with NO second LLM call and NO persistence
// (the wave card said "persisted" — the reference is response-only, and
// the pilot ports the reality). Six closed kinds, read-time scrubbing
// (secret shapes re-scrubbed, control chars collapsed, fields capped,
// weight clamped to [0,1], empty-snippet rows dropped, list bounded).
// Audits carry only the COUNT — scrubbed rows ride the response, never
// the audit row. Every source is already org-gated by the caller; a
// builder must never issue a cross-org read.
package aievidence

import (
	"regexp"
	"strings"

	"github.com/johnny4young/janusly/internal/signature"
)

// Reference caps, verbatim.
const (
	MaxEvidenceRows   = 24
	MaxSnippetChars   = 400
	MaxLabelChars     = 120
	MaxSourceRefChars = 200
)

// Kinds is the closed vocabulary.
var Kinds = map[string]bool{
	"recovery_feedback": true, "memory_entry": true, "runbook_excerpt": true,
	"recent_error": true, "signature_rule": true, "tool_contract": true,
}

// Row is one evidence entry.
type Row struct {
	Kind      string  `json:"kind"`
	SourceRef string  `json:"sourceRef"`
	Snippet   string  `json:"snippet"`
	Label     string  `json:"label,omitempty"`
	Weight    float64 `json:"weight,omitempty"`
}

var controlChars = regexp.MustCompile(`[\x00-\x1f\x7f]+`)
var whitespaceRuns = regexp.MustCompile(`\s+`)

func clampLine(value string, maxChars int) string {
	oneLine := signature.ScrubSecretShapes(strings.TrimSpace(
		whitespaceRuns.ReplaceAllString(controlChars.ReplaceAllString(value, " "), " ")))
	runes := []rune(oneLine)
	if len(runes) <= maxChars {
		return oneLine
	}
	// The reference caps CHARACTERS (JS string length): rune semantics.
	return strings.TrimRight(string(runes[:maxChars-1]), " ") + "…"
}

// ScrubRow is the read-time redaction + bounding for one row. Pure.
func ScrubRow(row Row) Row {
	scrubbed := Row{
		Kind:      row.Kind,
		SourceRef: clampLine(row.SourceRef, MaxSourceRefChars),
		Snippet:   clampLine(row.Snippet, MaxSnippetChars),
	}
	if row.Label != "" {
		scrubbed.Label = clampLine(row.Label, MaxLabelChars)
	}
	if row.Weight > 0 {
		scrubbed.Weight = row.Weight
		if scrubbed.Weight > 1 {
			scrubbed.Weight = 1
		}
	}
	return scrubbed
}

// ScrubRows scrubs + bounds a list: unknown kinds and empty-snippet rows
// drop, the list caps at MaxEvidenceRows.
func ScrubRows(rows []Row) []Row {
	out := make([]Row, 0, len(rows))
	for _, row := range rows {
		if len(out) >= MaxEvidenceRows {
			break
		}
		if !Kinds[row.Kind] {
			continue
		}
		scrubbed := ScrubRow(row)
		if scrubbed.Snippet == "" {
			continue
		}
		out = append(out, scrubbed)
	}
	return out
}

// RecentErrorRow builds the recent_error evidence from the DLQ error the
// route already holds (deterministic — no extra read).
func RecentErrorRow(runID string, errorJSON []byte) Row {
	return Row{
		Kind: "recent_error", SourceRef: runID,
		Snippet: string(errorJSON), Label: "Most recent failure",
	}
}

// SignatureRuleRow builds the signature_rule evidence from the normalized
// failure signature.
func SignatureRuleRow(failureSignature string) Row {
	return Row{
		Kind: "signature_rule", SourceRef: failureSignature,
		Snippet: "Failure clustered under signature: " + failureSignature,
		Label:   "Failure signature",
	}
}

// ToolContractRow builds the tool_contract evidence for a failing tool
// node from the registry entry the route already resolved.
func ToolContractRow(toolName, description string, required []string) Row {
	return Row{
		Kind: "tool_contract", SourceRef: toolName,
		Snippet: description + " Required inputs: " + strings.Join(required, ", "),
		Label:   "Tool contract: " + toolName,
	}
}
