package httpapi

import (
	"strings"

	"github.com/johnny4young/janusly/internal/authoring"
)

// Compatibility wrapper: the deterministic catalog is owned by authoring so
// HTTP and MCP cannot drift or mutate independent global templates.
func fallbackTemplateForPrompt(prompt string) map[string]any {
	return authoring.DeterministicWorkflow(prompt)
}

// containsAny remains package-local because assurance classification and
// redaction tests use the same case-normalized substring primitive as the
// legacy generation path. Authoring owns only template selection.
func containsAny(text string, needles ...string) bool {
	for _, needle := range needles {
		if strings.Contains(text, needle) {
			return true
		}
	}
	return false
}
