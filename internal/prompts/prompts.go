// PromptOps registry runtime resolver, implements the contract's
// prompt-resolver: the single chokepoint from a workflow author's
// promptRef {name, version?} to a resolved template body — never inline a
// prompt_versions read in a node executor or route. Resolution: the
// pinned version wins, else the latest PUBLISHED; then two substitution
// passes in order — {{include.Y}} (same-org active version, depth-first
// with a recursion stack against cycles, hard depth/reference/output caps)
// and {{var.X}}
// (declared variables from the caller's bag; a missing REQUIRED variable
// fails BEFORE any LLM call spends tokens). Everything else ({{secret.X}}
// etc.) passes through untouched for the engine substituter.
package prompts

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/internal/domain"
	"github.com/johnny4young/janusly/internal/store"
)

const (
	// MaxIncludeDepth mirrors the contract's defensive cap.
	MaxIncludeDepth = 8
	// MaxIncludeReferences bounds database work even when the source template
	// repeats the same valid include many times.
	MaxIncludeReferences = 64
	// MaxResolvedTemplateBytes bounds both include and variable expansion before
	// the result reaches an AI executor. Individual stored templates are capped
	// lower by the HTTP write surface.
	MaxResolvedTemplateBytes = 128 * 1024
	MaxVariables             = 64
	MaxVariableDefaultBytes  = 8 * 1024
	MaxVariableDefaultsBytes = 64 * 1024
)

// ErrPromptNotFound: the caller (the ai node) falls back to its inline
// prompt literal — the registry being absent is never fatal.
var ErrPromptNotFound = errors.New("prompt not found")

// MissingVariableError names the required variable that was not supplied.
type MissingVariableError struct{ Name string }

func (e *MissingVariableError) Error() string {
	return fmt.Sprintf("required prompt variable %q was not supplied", e.Name)
}

// Variable is one declared template variable.
type Variable struct {
	Name     string `json:"name"`
	Required bool   `json:"required,omitempty"`
	Default  string `json:"default,omitempty"`
}

var (
	includePattern = regexp.MustCompile(`\{\{include\.([A-Za-z0-9_.-]+)\}\}`)
	varPattern     = regexp.MustCompile(`\{\{var\.([A-Za-z0-9_.-]+)\}\}`)
	variableName   = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)
)

// DecodeVariables parses the complete JSON document with unknown fields
// refused, then applies the same declaration contract used when legacy rows
// are resolved.
func DecodeVariables(raw []byte) ([]Variable, error) {
	if len(bytes.TrimSpace(raw)) == 0 {
		raw = []byte(`[]`)
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return nil, fmt.Errorf("variables must be an array")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var declared []Variable
	if err := decoder.Decode(&declared); err != nil {
		return nil, fmt.Errorf("variables must be an array of {name, required?, default?}: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		if err == nil {
			return nil, fmt.Errorf("variables must contain exactly one JSON document")
		}
		return nil, fmt.Errorf("variables must contain exactly one JSON document: %w", err)
	}
	if err := ValidateVariables(declared); err != nil {
		return nil, err
	}
	return declared, nil
}

// ValidateVariables keeps declaration names executable by varPattern and
// prevents repeated defaults from inflating a resolved prompt without bound.
func ValidateVariables(declared []Variable) error {
	if len(declared) > MaxVariables {
		return fmt.Errorf("variables supports at most %d entries", MaxVariables)
	}
	seen := make(map[string]bool, len(declared))
	totalDefaults := 0
	for _, variable := range declared {
		if !variableName.MatchString(variable.Name) {
			return fmt.Errorf("variable names must contain 1..64 letters, numbers, dots, underscores, or hyphens")
		}
		if seen[variable.Name] {
			return fmt.Errorf("variable %q is declared more than once", variable.Name)
		}
		seen[variable.Name] = true
		if len(variable.Default) > MaxVariableDefaultBytes {
			return fmt.Errorf("variable %q default exceeds %d bytes", variable.Name, MaxVariableDefaultBytes)
		}
		totalDefaults += len(variable.Default)
		if totalDefaults > MaxVariableDefaultsBytes {
			return fmt.Errorf("variable defaults exceed %d bytes in total", MaxVariableDefaultsBytes)
		}
	}
	return nil
}

// ResolveActive returns the prompt's active version: pinned (org-scoped)
// or the latest published. pgx.ErrNoRows maps to ErrPromptNotFound.
func ResolveActive(ctx context.Context, db store.DBTX, orgID, promptID string) (store.PromptVersion, error) {
	q := store.New(db)
	prompt, err := q.GetPromptRowByID(ctx, store.GetPromptRowByIDParams{OrgID: orgID, ID: promptID})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return store.PromptVersion{}, ErrPromptNotFound
		}
		return store.PromptVersion{}, err
	}
	if prompt.PinnedVersionID.Valid {
		pinned, err := q.GetPromptVersionByID(ctx, store.GetPromptVersionByIDParams{
			OrgID: orgID, ID: prompt.PinnedVersionID.String,
		})
		if err == nil {
			return pinned, nil
		}
		// Defensive fall-through: a pinned id outside this org is
		// structurally unreachable; latest keeps the resolver total.
	}
	latest, err := q.GetLatestPublishedPromptVersion(ctx, store.GetLatestPublishedPromptVersionParams{
		OrgID: orgID, PromptID: promptID,
	})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return store.PromptVersion{}, ErrPromptNotFound
		}
		return store.PromptVersion{}, err
	}
	return latest, nil
}

// ResolveTemplate flattens a promptRef into the template body ready for
// the engine substituter: name → active (or exact version), includes
// expanded, declared variables substituted.
func ResolveTemplate(ctx context.Context, db store.DBTX, orgID, name string, version int, variables map[string]string) (string, error) {
	if err := domain.ValidatePromptName(name); err != nil {
		return "", err
	}
	q := store.New(db)
	prompt, err := q.GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: orgID, Name: name})
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrPromptNotFound
		}
		return "", err
	}
	var active store.PromptVersion
	if version > 0 {
		active, err = q.GetPromptVersionByNumber(ctx, store.GetPromptVersionByNumberParams{
			OrgID: orgID, PromptID: prompt.ID, Version: int32(version),
		})
		if errors.Is(err, pgx.ErrNoRows) {
			return "", ErrPromptNotFound
		}
	} else {
		active, err = ResolveActive(ctx, db, orgID, prompt.ID)
	}
	if err != nil {
		return "", err
	}
	expanded, err := expandIncludes(ctx, db, orgID, active.TemplateText, map[string]bool{prompt.ID: true}, 1)
	if err != nil {
		return "", err
	}
	return substituteVariables(expanded, active.Variables, variables)
}

type expandedInclude struct {
	promptID string
	text     string
}

type includeExpansion struct {
	stack      map[string]bool
	references int
	cache      map[string]expandedInclude
}

func appendResolved(builder *strings.Builder, value string) error {
	if len(value) > MaxResolvedTemplateBytes-builder.Len() {
		return fmt.Errorf("resolved prompt exceeds %d bytes", MaxResolvedTemplateBytes)
	}
	builder.WriteString(value)
	return nil
}

// expandIncludes resolves {{include.Y}} depth-first with stack-based cycle
// rejection. Reusing one prompt in separate branches is valid; only a prompt
// still on the current recursion stack is a cycle.
func expandIncludes(ctx context.Context, db store.DBTX, orgID, text string, visited map[string]bool, depth int) (string, error) {
	if visited == nil {
		visited = map[string]bool{}
	}
	state := &includeExpansion{stack: visited, cache: map[string]expandedInclude{}}
	return state.expand(ctx, db, orgID, text, depth)
}

func (state *includeExpansion) expand(ctx context.Context, db store.DBTX, orgID, text string, depth int) (string, error) {
	if depth > MaxIncludeDepth {
		return "", fmt.Errorf("prompt include depth exceeds %d", MaxIncludeDepth)
	}
	if len(text) > MaxResolvedTemplateBytes {
		return "", fmt.Errorf("resolved prompt exceeds %d bytes", MaxResolvedTemplateBytes)
	}
	matches := includePattern.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		return text, nil
	}
	var out strings.Builder
	out.Grow(min(len(text), MaxResolvedTemplateBytes))
	last := 0
	for _, match := range matches {
		if err := appendResolved(&out, text[last:match[0]]); err != nil {
			return "", err
		}
		state.references++
		if state.references > MaxIncludeReferences {
			return "", fmt.Errorf("prompt includes exceed %d references", MaxIncludeReferences)
		}
		name := text[match[2]:match[3]]
		if err := domain.ValidatePromptName(name); err != nil {
			return "", fmt.Errorf("include %q: %w", name, err)
		}
		if cached, ok := state.cache[name]; ok {
			if state.stack[cached.promptID] {
				return "", fmt.Errorf("include cycle through prompt %q", name)
			}
			if err := appendResolved(&out, cached.text); err != nil {
				return "", err
			}
			last = match[1]
			continue
		}
		included, err := store.New(db).GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: orgID, Name: name})
		if err != nil {
			return "", fmt.Errorf("include %q: %w", name, ErrPromptNotFound)
		}
		if state.stack[included.ID] {
			return "", fmt.Errorf("include cycle through prompt %q", name)
		}
		state.stack[included.ID] = true
		active, err := ResolveActive(ctx, db, orgID, included.ID)
		if err != nil {
			delete(state.stack, included.ID)
			return "", fmt.Errorf("include %q: %w", name, err)
		}
		nested, err := state.expand(ctx, db, orgID, active.TemplateText, depth+1)
		delete(state.stack, included.ID)
		if err != nil {
			return "", err
		}
		state.cache[name] = expandedInclude{promptID: included.ID, text: nested}
		if err := appendResolved(&out, nested); err != nil {
			return "", err
		}
		last = match[1]
	}
	if err := appendResolved(&out, text[last:]); err != nil {
		return "", err
	}
	return out.String(), nil
}

// substituteVariables applies {{var.X}} from the caller's bag against the
// version's declared variables; a missing required one fails fast.
func substituteVariables(text string, declaredJSON []byte, supplied map[string]string) (string, error) {
	declared, err := DecodeVariables(declaredJSON)
	if err != nil {
		return "", fmt.Errorf("stored prompt variables are invalid: %w", err)
	}
	byName := make(map[string]Variable, len(declared))
	for _, variable := range declared {
		byName[variable.Name] = variable
	}
	for _, variable := range declared {
		if variable.Required {
			if _, ok := supplied[variable.Name]; !ok && variable.Default == "" {
				return "", &MissingVariableError{Name: variable.Name}
			}
		}
	}
	matches := varPattern.FindAllStringSubmatchIndex(text, -1)
	if len(matches) == 0 {
		if len(text) > MaxResolvedTemplateBytes {
			return "", fmt.Errorf("resolved prompt exceeds %d bytes", MaxResolvedTemplateBytes)
		}
		return text, nil
	}
	var out strings.Builder
	out.Grow(min(len(text), MaxResolvedTemplateBytes))
	last := 0
	for _, match := range matches {
		if err := appendResolved(&out, text[last:match[0]]); err != nil {
			return "", err
		}
		name := text[match[2]:match[3]]
		replacement := text[match[0]:match[1]] // undeclared tokens remain visible
		if value, ok := supplied[name]; ok {
			replacement = value
		} else if variable, ok := byName[name]; ok && variable.Default != "" {
			replacement = variable.Default
		}
		if err := appendResolved(&out, replacement); err != nil {
			return "", err
		}
		last = match[1]
	}
	if err := appendResolved(&out, text[last:]); err != nil {
		return "", err
	}
	return out.String(), nil
}
