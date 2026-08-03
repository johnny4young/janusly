package aievidence

import (
	"strings"
	"testing"
)

// Caps + scrub + shape: control chars collapse, secrets re-scrub at read
// time, fields cap with the ellipsis, weight clamps, unknown kinds and
// empty snippets drop, and the list bounds at 24.
func TestScrubRowsCapsAndScrubs(t *testing.T) {
	long := strings.Repeat("x", 900)
	rows := make([]Row, 0, 30)
	for range 28 {
		rows = append(rows, Row{Kind: "recent_error", SourceRef: "run-1", Snippet: long})
	}
	rows = append(rows,
		Row{Kind: "made_up", SourceRef: "x", Snippet: "dropped"},
		Row{Kind: "memory_entry", SourceRef: "m1", Snippet: "   \x00\x1f  "},
	)
	out := ScrubRows(rows)
	if len(out) != MaxEvidenceRows {
		t.Fatalf("list must bound at %d: %d", MaxEvidenceRows, len(out))
	}
	if snippetRunes := len([]rune(out[0].Snippet)); snippetRunes > MaxSnippetChars || !strings.HasSuffix(out[0].Snippet, "…") {
		t.Fatalf("snippet cap (runes): %d", snippetRunes)
	}

	scrubbed := ScrubRow(Row{
		Kind:      "recovery_feedback",
		SourceRef: strings.Repeat("r", 300),
		Snippet:   "header Bearer abc123def456ghi789jkl012mno345 leaked\x00and control",
		Label:     strings.Repeat("l", 200),
		Weight:    3.5,
	})
	if refRunes, labelRunes := len([]rune(scrubbed.SourceRef)), len([]rune(scrubbed.Label)); refRunes > MaxSourceRefChars || labelRunes > MaxLabelChars {
		t.Fatalf("field caps (runes): ref=%d label=%d", refRunes, labelRunes)
	}
	if strings.Contains(scrubbed.Snippet, "abc123def456ghi789jkl012mno345") {
		t.Fatalf("secret must re-scrub at read time: %q", scrubbed.Snippet)
	}
	if strings.Contains(scrubbed.Snippet, "\x00") {
		t.Fatal("control chars must collapse")
	}
	if scrubbed.Weight != 1 {
		t.Fatalf("weight must clamp to [0,1]: %f", scrubbed.Weight)
	}
}
