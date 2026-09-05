// Template engine for node configs and tool inputs, implements the
// reference: substitutes {{context.<nodeId>.output.<path>}},
// {{context.input.<name>}}, {{inputs.<name>}}, {{secret.NAME}} and
// {{env.NAME}}. Every resolved secret AND env value (length >= 4) lands in a
// redaction list so callers can strip plaintext from outputs and errors
// before persistence — the renderer itself never persists anything.
//
// Contract inherited from the contract:
//   - a string that is exactly one {{...}} reference returns the resolved
//     value's native type (arrays/objects/numbers survive);
//   - multi-reference strings interpolate (objects as JSON, null as "");
//   - a missing ordinary path renders "" and is tracked as unresolved;
//   - a missing env renders "" (tracked as env.*); a missing secret is a
//     hard failure.
package grammar

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"
)

// MaxRecordedUnresolvedPaths bounds the paths carried by the strict-policy
// error envelope.
const MaxRecordedUnresolvedPaths = 20

var singleRefPattern = regexp.MustCompile(`^\s*\{\{\s*([^}]+?)\s*\}\}\s*$`)
var multiRefPattern = regexp.MustCompile(`\{\{\s*([^}]+?)\s*\}\}`)

// WholeTemplateReference reports the expression carried by a string whose
// entire value is exactly one Janusly template reference. Whole references
// are special because rendering preserves the referenced value's native JSON
// type; interpolated references always render as strings.
func WholeTemplateReference(value string) (expression string, ok bool) {
	match := singleRefPattern.FindStringSubmatch(value)
	if match == nil {
		return "", false
	}
	expression = strings.TrimSpace(match[1])
	if expression == "" {
		return "", false
	}
	return expression, true
}

// RenderOptions injects the environment and secret sources plus the
// executor-owned roots whose resolution is deferred to a later lifecycle
// point (loop item/index, sequential previousAgents).
type RenderOptions struct {
	// LookupEnv resolves an environment variable; nil disables env access
	// (every env reference then reads as unset). Mirrors os.LookupEnv.
	LookupEnv func(name string) (string, bool)
	// LookupSecret resolves a secret by UPPERCASED name; a false return is
	// the hard "Missing secret" failure. Nil behaves as all-missing.
	LookupSecret func(name string) (string, bool)
	// DeferredRoots are path roots left verbatim for a later render pass.
	DeferredRoots []string
}

// RenderResult carries the rendered value plus the redaction and
// unresolved-path evidence the caller must act on before persisting.
type RenderResult struct {
	Rendered        any
	RedactedValues  []string
	UnresolvedPaths []string
}

// MissingSecretError is the hard failure for an unresolvable {{secret.X}};
// unlike ordinary paths it never degrades to an empty string.
type MissingSecretError struct{ Name string }

func (e *MissingSecretError) Error() string { return "Missing secret: " + e.Name }

// UnresolvedTemplatePathError is the stable strict-policy envelope: count,
// bounded path list, truncation marker. Emitted by callers when a persisted
// templatePolicy of "strict" turns unresolved evidence into a failure.
type UnresolvedTemplatePathError struct {
	Count     int
	Paths     []string
	Truncated bool
}

func (e *UnresolvedTemplatePathError) Error() string {
	plural := "s"
	if e.Count == 1 {
		plural = ""
	}
	return fmt.Sprintf("Node config contains %d unresolved template path%s", e.Count, plural)
}

func (*UnresolvedTemplatePathError) ErrorName() string    { return "UnresolvedTemplatePathError" }
func (*UnresolvedTemplatePathError) ErrorCode() string    { return "UNRESOLVED_TEMPLATE_PATH" }
func (*UnresolvedTemplatePathError) ErrorStatusCode() int { return 0 }

// NewUnresolvedTemplatePathError bounds the recorded paths like the
// reference envelope.
func NewUnresolvedTemplatePathError(paths []string) *UnresolvedTemplatePathError {
	bounded := paths
	if len(bounded) > MaxRecordedUnresolvedPaths {
		bounded = bounded[:MaxRecordedUnresolvedPaths]
	}
	return &UnresolvedTemplatePathError{
		Count: len(paths), Paths: bounded, Truncated: len(paths) > len(bounded),
	}
}

type renderState struct {
	opts          RenderOptions
	redacted      []string
	redactedSeen  map[string]bool
	unresolved    []string
	unresolvedSet map[string]bool
	deferredRoots map[string]bool
}

// RenderTemplate renders without redaction tracking; a lone {{...}} string
// returns the resolved value's native type, so callers must narrow.
func RenderTemplate(value any, scope map[string]any) (any, error) {
	result, err := RenderTemplateWithRedactions(value, scope, RenderOptions{})
	if err != nil {
		return nil, err
	}
	return result.Rendered, nil
}

// RenderTemplateWithRedactions renders value against scope and collects
// every resolved secret/env value into the redaction list, plus every
// unresolved ordinary path (secret./env. names are anonymized).
func RenderTemplateWithRedactions(value any, scope map[string]any, opts RenderOptions) (RenderResult, error) {
	state := &renderState{
		opts:          opts,
		redactedSeen:  map[string]bool{},
		unresolvedSet: map[string]bool{},
		deferredRoots: map[string]bool{},
	}
	for _, root := range opts.DeferredRoots {
		state.deferredRoots[root] = true
	}
	rendered, err := renderValue(value, scope, state)
	if err != nil {
		return RenderResult{}, err
	}
	// Go maps do not retain the authored JSON property order. Canonicalize the
	// evidence once after rendering so retries and replicas emit the same bounded
	// path list rather than inheriting randomized map iteration.
	slices.Sort(state.unresolved)
	return RenderResult{
		Rendered:        rendered,
		RedactedValues:  state.redacted,
		UnresolvedPaths: state.unresolved,
	}, nil
}

// MapInput renders a mapping object/string against scope; nil maps to {}.
// Used by transform, loop iterations, and tool-input templating.
func MapInput(mapping any, scope map[string]any) (any, error) {
	if mapping == nil {
		return map[string]any{}, nil
	}
	return RenderTemplate(mapping, scope)
}

// GetByPath walks a dotted path (numeric segments index arrays); any absent
// link returns (nil, false), mirroring the contract's undefined.
func GetByPath(source any, path string) (any, bool) {
	current := source
	for key := range strings.SplitSeq(path, ".") {
		child := childValue(current, key)
		if isUndefined(child) {
			return nil, false
		}
		current = child
	}
	return current, true
}

func renderValue(value any, scope map[string]any, state *renderState) (any, error) {
	switch v := value.(type) {
	case string:
		return renderString(v, scope, state)
	case []any:
		out := make([]any, len(v))
		for i, item := range v {
			rendered, err := renderValue(item, scope, state)
			if err != nil {
				return nil, err
			}
			out[i] = rendered
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(v))
		for key, item := range v {
			rendered, err := renderValue(item, scope, state)
			if err != nil {
				return nil, err
			}
			out[key] = rendered
		}
		return out, nil
	default:
		return value, nil
	}
}

func renderString(value string, scope map[string]any, state *renderState) (any, error) {
	// Single-template-contract shape: the whole string is one {{...}}, so
	// the resolved value keeps its native type — without this, a templated
	// array would degrade into its JSON string form.
	if expr, wholeReference := WholeTemplateReference(value); wholeReference {
		if state.deferredRoots[pathRoot(expr)] {
			return value, nil
		}
		if strings.HasPrefix(expr, "secret.") {
			return resolveSecret(expr, state)
		}
		if strings.HasPrefix(expr, "env.") {
			return resolveEnv(expr, state), nil
		}
		resolved, found := GetByPath(scope, expr)
		if !found {
			state.trackUnresolved(expr)
			return "", nil
		}
		if resolved == nil {
			return "", nil
		}
		return resolved, nil
	}

	var firstErr error
	rendered := multiRefPattern.ReplaceAllStringFunc(value, func(match string) string {
		if firstErr != nil {
			return match
		}
		expr := strings.TrimSpace(multiRefPattern.FindStringSubmatch(match)[1])
		if state.deferredRoots[pathRoot(expr)] {
			return match
		}
		if strings.HasPrefix(expr, "secret.") {
			resolved, err := resolveSecret(expr, state)
			if err != nil {
				firstErr = err
				return match
			}
			return resolved.(string)
		}
		if strings.HasPrefix(expr, "env.") {
			return resolveEnv(expr, state).(string)
		}
		resolved, found := GetByPath(scope, expr)
		if !found {
			state.trackUnresolved(expr)
			return ""
		}
		if resolved == nil {
			return ""
		}
		switch resolved.(type) {
		case map[string]any, []any:
			// Interpolated objects serialize as JSON. Go marshals map keys
			// alphabetically where JS keeps insertion order — an accepted
			// divergence recorded in the plan.
			raw, err := json.Marshal(resolved)
			if err != nil {
				return ""
			}
			return string(raw)
		default:
			return jsString(resolved)
		}
	})
	if firstErr != nil {
		return nil, firstErr
	}
	return rendered, nil
}

func resolveSecret(expr string, state *renderState) (any, error) {
	name := strings.ToUpper(strings.TrimPrefix(expr, "secret."))
	var resolved string
	ok := false
	if state.opts.LookupSecret != nil {
		resolved, ok = state.opts.LookupSecret(name)
	}
	if !ok || resolved == "" {
		return nil, &MissingSecretError{Name: name}
	}
	if len(resolved) >= 4 {
		state.trackRedacted(resolved)
	}
	return resolved, nil
}

func resolveEnv(expr string, state *renderState) any {
	name := strings.ToUpper(strings.TrimPrefix(expr, "env."))
	var value string
	defined := false
	if state.opts.LookupEnv != nil {
		value, defined = state.opts.LookupEnv(name)
	}
	if !defined {
		state.trackUnresolved(expr)
		return ""
	}
	if value != "" && len(value) >= 4 {
		state.trackRedacted(value)
	}
	return value
}

func (s *renderState) trackRedacted(value string) {
	if s.redactedSeen[value] {
		return
	}
	s.redactedSeen[value] = true
	s.redacted = append(s.redacted, value)
}

// trackUnresolved records a deduplicated, privacy-safe form of the path:
// secret/env names are anonymized to their root, ordinary paths bounded to
// 160 characters.
func (s *renderState) trackUnresolved(path string) {
	safe := path
	switch {
	case strings.HasPrefix(path, "secret."):
		safe = "secret.*"
	case strings.HasPrefix(path, "env."):
		safe = "env.*"
	case len(path) > 160:
		safe = path[:160]
	}
	if s.unresolvedSet[safe] {
		return
	}
	s.unresolvedSet[safe] = true
	s.unresolved = append(s.unresolved, safe)
}

func pathRoot(expr string) string {
	root, _, _ := strings.Cut(expr, ".")
	return root
}
