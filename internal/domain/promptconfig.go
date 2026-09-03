package domain

import (
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	// PromptReferenceMaxNameLength mirrors the PromptOps name boundary.
	PromptReferenceMaxNameLength = 128
	// PromptReferenceMaxVersion keeps references representable by the
	// PostgreSQL int4 version column.
	PromptReferenceMaxVersion = 2_147_483_647
)

var promptNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`)

// ValidatePromptName is the single PromptOps identifier grammar shared by
// HTTP path parameters, persisted workflow references, includes, and the
// runtime resolver. Names are URL-segment-safe ASCII identifiers by design;
// descriptions carry localized display copy.
func ValidatePromptName(name string) error {
	if strings.TrimSpace(name) == "" || utf8.RuneCountInString(name) > PromptReferenceMaxNameLength ||
		!promptNamePattern.MatchString(name) {
		return fmt.Errorf("prompt name must be 1..%d characters, start with a letter or number, and contain only letters, numbers, dot, underscore, or hyphen", PromptReferenceMaxNameLength)
	}
	return nil
}

// PromptReference is the normalized PromptOps pointer shared by authoring and
// execution. Version zero means "resolve the active version"; an explicitly
// authored version must always be positive.
type PromptReference struct {
	Name    string
	Version int
}

// ResolvePromptReference validates a PromptOps reference stored under field.
// Presence is returned separately because an omitted reference is valid for
// nodes that use an inline prompt instead.
func ResolvePromptReference(config map[string]any, field string) (PromptReference, bool, error) {
	raw, present := config[field]
	if !present {
		return PromptReference{}, false, nil
	}
	ref, ok := raw.(map[string]any)
	if !ok || ref == nil {
		return PromptReference{}, true, fmt.Errorf("%s must be an object with a non-empty name", field)
	}
	name, ok := ref["name"].(string)
	if !ok || strings.TrimSpace(name) == "" {
		return PromptReference{}, true, fmt.Errorf("%s.name must be a non-empty string", field)
	}
	if err := ValidatePromptName(name); err != nil {
		return PromptReference{}, true, fmt.Errorf("%s.name: %w", field, err)
	}
	version := 0
	if rawVersion, versionPresent := ref["version"]; versionPresent {
		resolved, valid := boundedAgentInteger(rawVersion, 1, PromptReferenceMaxVersion)
		if !valid {
			return PromptReference{}, true, fmt.Errorf("%s.version must be an integer between 1 and %d", field, PromptReferenceMaxVersion)
		}
		version = resolved
	}
	return PromptReference{Name: name, Version: version}, true, nil
}

// ResolvePromptVariables validates the caller-supplied PromptOps substitution
// bag. Dropping non-string values silently changes a prompt, so both save-time
// and runtime reject the whole bag instead.
func ResolvePromptVariables(config map[string]any) (map[string]string, error) {
	raw, present := config["variables"]
	if !present {
		return map[string]string{}, nil
	}
	values, ok := raw.(map[string]any)
	if !ok || values == nil {
		return nil, fmt.Errorf("variables must be an object with string values")
	}
	resolved := make(map[string]string, len(values))
	for key, value := range values {
		text, ok := value.(string)
		if !ok {
			return nil, fmt.Errorf("variables[%q] must be a string", key)
		}
		resolved[key] = text
	}
	return resolved, nil
}
