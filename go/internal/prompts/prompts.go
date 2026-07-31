// PromptOps registry runtime resolver, ported from the reference's
// prompt-resolver: the single chokepoint from a workflow author's
// promptRef {name, version?} to a resolved template body — never inline a
// prompt_versions read in a node executor or route. Resolution: the
// pinned version wins, else the latest PUBLISHED; then two substitution
// passes in order — {{include.Y}} (same-org active version, depth-first
// with a visited set against cycles, hard depth cap 8) and {{var.X}}
// (declared variables from the caller's bag; a missing REQUIRED variable
// fails BEFORE any LLM call spends tokens). Everything else ({{secret.X}}
// etc.) passes through untouched for the engine substituter.
package prompts

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/jackc/pgx/v5"

	"github.com/johnny4young/janusly/go/internal/store"
)

// MaxIncludeDepth mirrors the reference's defensive cap.
const MaxIncludeDepth = 8

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
)

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

// expandIncludes resolves {{include.Y}} depth-first with cycle rejection.
func expandIncludes(ctx context.Context, db store.DBTX, orgID, text string, visited map[string]bool, depth int) (string, error) {
	if depth > MaxIncludeDepth {
		return "", fmt.Errorf("prompt include depth exceeds %d", MaxIncludeDepth)
	}
	var expandErr error
	out := includePattern.ReplaceAllStringFunc(text, func(match string) string {
		if expandErr != nil {
			return match
		}
		name := includePattern.FindStringSubmatch(match)[1]
		included, err := store.New(db).GetPromptByName(ctx, store.GetPromptByNameParams{OrgID: orgID, Name: name})
		if err != nil {
			expandErr = fmt.Errorf("include %q: %w", name, ErrPromptNotFound)
			return match
		}
		if visited[included.ID] {
			expandErr = fmt.Errorf("include cycle through prompt %q", name)
			return match
		}
		visited[included.ID] = true
		active, err := ResolveActive(ctx, db, orgID, included.ID)
		if err != nil {
			expandErr = fmt.Errorf("include %q: %w", name, err)
			return match
		}
		nested, err := expandIncludes(ctx, db, orgID, active.TemplateText, visited, depth+1)
		if err != nil {
			expandErr = err
			return match
		}
		return nested
	})
	return out, expandErr
}

// substituteVariables applies {{var.X}} from the caller's bag against the
// version's declared variables; a missing required one fails fast.
func substituteVariables(text string, declaredJSON []byte, supplied map[string]string) (string, error) {
	var declared []Variable
	_ = json.Unmarshal(declaredJSON, &declared)
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
	return varPattern.ReplaceAllStringFunc(text, func(match string) string {
		name := varPattern.FindStringSubmatch(match)[1]
		if value, ok := supplied[name]; ok {
			return value
		}
		if variable, ok := byName[name]; ok && variable.Default != "" {
			return variable.Default
		}
		return match // undeclared token passes through for the engine layer
	}), nil
}
