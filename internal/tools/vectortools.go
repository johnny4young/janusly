// The org-scoped vector memory tool family: catalog entries whose execution
// requires engine context, so the tool-node executor intercepts them.
package tools

import (
	"context"
	"fmt"
	"strings"
)

// vectorTools are catalog entries for the org-scoped memory tools. Their
// execution REQUIRES engine context (org, run, consent), so the tool-node
// executor intercepts them before generic dispatch; calling them through
// the bare registry (no engine) answers with the engine-context error.
const (
	vectorTextMaxBytes     = 64 << 10
	vectorMetadataMaxBytes = 16 << 10
)

func validateVectorText(input map[string]any, field string, options InputValidationOptions) error {
	raw, present := input[field]
	if !present || isDeferredWholeTemplate(raw, options) {
		return nil
	}
	value := raw.(string)
	if strings.TrimSpace(value) == "" || len(value) > vectorTextMaxBytes {
		return fmt.Errorf("%s must be non-empty and at most %d bytes", field, vectorTextMaxBytes)
	}
	return nil
}

func validateVectorSearchInput(input map[string]any, options InputValidationOptions) error {
	return validateVectorText(input, "query", options)
}

func validateVectorUpsertInput(input map[string]any, options InputValidationOptions) error {
	if err := validateVectorText(input, "content", options); err != nil {
		return err
	}
	if raw, present := input["metadata"]; present && !isDeferredWholeTemplate(raw, options) {
		if err := validateBoundedJSONValue(raw, vectorMetadataMaxBytes, true); err != nil {
			return fmt.Errorf("metadata: %w", err)
		}
	}
	return nil
}

func vectorTools() []Definition {
	engineOnly := func(context.Context, map[string]any) (map[string]any, error) {
		return nil, fmt.Errorf("vector tools require engine context")
	}
	return []Definition{
		{
			Name:        "vector.search",
			Description: "Search the org's vector memory (workflow_vector kind) by semantic similarity.",
			Required:    []string{"query"},
			Fields: []Field{
				{Name: "query", Type: "string"},
			},
			InputExample: map[string]any{"query": "prior fixes for the billing webhook"},
			Validate:     validateVectorSearchInput,
			Execute:      engineOnly,
		},
		{
			Name:        "vector.upsert",
			Description: "Store one entry in the org's vector memory (workflow_vector kind). Consent-gated.",
			Required:    []string{"content"},
			Fields: []Field{
				{Name: "content", Type: "string"},
				{Name: "metadata", Type: "object"},
			},
			InputExample: map[string]any{"content": "retries with backoff fixed the timeout"},
			Validate:     validateVectorUpsertInput,
			WriteSide:    true,
			Execute:      engineOnly,
		},
	}
}
