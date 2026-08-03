// Declared-outputs projection: when a run flips to succeeded, each entry of
// the workflow's outputs map (name → template string) renders against the
// terminal context and the run input, and the result persists to
// runs.output_json. Output templates are user-visible, so secret/env
// references are masked before rendering — they must never resolve here.
package engine

import (
	"regexp"

	"github.com/johnny4young/janusly/internal/grammar"
)

var persistenceOnlyRef = regexp.MustCompile(`(?i)\{\{\s*(?:secret|env)\.[^}]+\s*\}\}`)

// projectOutputs renders every declared output template against
// {context, inputs}. Single-reference templates preserve native types;
// interpolated strings coerce, matching the template contract.
func projectOutputs(spec map[string]string, runContext map[string]any, runInput map[string]any) map[string]any {
	projected := make(map[string]any, len(spec))
	scope := map[string]any{"context": runContext, "inputs": runInput}
	for key, template := range spec {
		masked := persistenceOnlyRef.ReplaceAllString(template, "[redacted]")
		rendered, err := grammar.RenderTemplate(masked, scope)
		if err != nil {
			rendered = ""
		}
		projected[key] = rendered
	}
	return projected
}
