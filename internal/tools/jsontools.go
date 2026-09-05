// The local json.* tool family and its validators, ported from the source
// contract with the prototype-pollution guards those tools carry.
package tools

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"strconv"
	"strings"
)

// prototypeKeys are the JS prototype-pollution vectors the contract tools
// refuse; in Go they are ordinary map keys, but refusing them keeps a
// runtime-produced payload safe to feed back into the Janusly API.
var prototypeKeys = map[string]bool{"__proto__": true, "prototype": true, "constructor": true}

const (
	jsonToolMaxBytes = 2 << 20
	jsonToolMaxDepth = 64
	jsonPathMaxBytes = 1_024
	jsonPathMaxParts = 64
)

func validateNormalizedJSONTree(value any, depth int, rejectPrototype bool) error {
	if depth > jsonToolMaxDepth {
		return fmt.Errorf("JSON nesting exceeds %d levels", jsonToolMaxDepth)
	}
	switch typed := value.(type) {
	case map[string]any:
		for key, child := range typed {
			if rejectPrototype && prototypeKeys[key] {
				return fmt.Errorf("JSON contains forbidden object key %s", key)
			}
			if err := validateNormalizedJSONTree(child, depth+1, rejectPrototype); err != nil {
				return err
			}
		}
	case []any:
		for _, child := range typed {
			if err := validateNormalizedJSONTree(child, depth+1, rejectPrototype); err != nil {
				return err
			}
		}
	}
	return nil
}

func validateBoundedJSONValue(value any, maximum int) error {
	const rejectPrototype = true
	serialized, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("value must be valid JSON")
	}
	if len(serialized) > maximum {
		return fmt.Errorf("JSON value exceeds %d bytes", maximum)
	}
	var normalized any
	decoder := json.NewDecoder(strings.NewReader(string(serialized)))
	decoder.UseNumber()
	if err := decoder.Decode(&normalized); err != nil {
		return fmt.Errorf("value must be valid JSON")
	}
	return validateNormalizedJSONTree(normalized, 0, rejectPrototype)
}

func validateJSONPath(path string) error {
	if path == "" || path != strings.TrimSpace(path) || len(path) > jsonPathMaxBytes {
		return fmt.Errorf("path must be a trimmed non-empty string of at most %d bytes", jsonPathMaxBytes)
	}
	parts := strings.Split(path, ".")
	if len(parts) > jsonPathMaxParts {
		return fmt.Errorf("path must contain at most %d segments", jsonPathMaxParts)
	}
	for _, part := range parts {
		if part == "" {
			return fmt.Errorf("path segments must not be empty")
		}
		if prototypeKeys[part] {
			return fmt.Errorf("path contains forbidden segment %s", part)
		}
	}
	return nil
}

func validateJSONParseInput(input map[string]any, options InputValidationOptions) error {
	raw, present := input["value"]
	if !present || isDeferredWholeTemplate(raw, options) {
		return nil
	}
	text := raw.(string)
	if len(text) > jsonToolMaxBytes {
		return fmt.Errorf("JSON text exceeds %d bytes", jsonToolMaxBytes)
	}
	var parsed any
	decoder := json.NewDecoder(strings.NewReader(text))
	decoder.UseNumber()
	if err := decoder.Decode(&parsed); err != nil {
		return fmt.Errorf("value must contain valid JSON")
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("value must contain exactly one JSON document")
	}
	return validateNormalizedJSONTree(parsed, 0, false)
}

func validateJSONPickInput(input map[string]any, options InputValidationOptions) error {
	if raw, present := input["path"]; present && !isDeferredWholeTemplate(raw, options) {
		if err := validateJSONPath(raw.(string)); err != nil {
			return err
		}
	}
	if raw, present := input["source"]; present && !isDeferredWholeTemplate(raw, options) {
		return validateBoundedJSONValue(raw, jsonToolMaxBytes)
	}
	return nil
}

func validateJSONSetInput(input map[string]any, options InputValidationOptions) error {
	pathRaw, pathPresent := input["path"]
	pathDeferred := pathPresent && isDeferredWholeTemplate(pathRaw, options)
	if pathPresent && !pathDeferred {
		if err := validateJSONPath(pathRaw.(string)); err != nil {
			return err
		}
	}
	sourceRaw, sourcePresent := input["source"]
	sourceDeferred := sourcePresent && isDeferredWholeTemplate(sourceRaw, options)
	if sourcePresent && !sourceDeferred {
		if err := validateBoundedJSONValue(sourceRaw, jsonToolMaxBytes); err != nil {
			return fmt.Errorf("source: %w", err)
		}
	}
	valueRaw, valuePresent := input["value"]
	valueDeferred := valuePresent && isDeferredWholeTemplate(valueRaw, options)
	if valuePresent && !valueDeferred {
		if err := validateBoundedJSONValue(valueRaw, jsonToolMaxBytes); err != nil {
			return fmt.Errorf("value: %w", err)
		}
	}
	if pathPresent && !pathDeferred && !sourceDeferred && valuePresent && !valueDeferred {
		result, err := setByPath(sourceRaw, pathRaw.(string), valueRaw)
		if err != nil {
			return err
		}
		if err := validateBoundedJSONValue(result, jsonToolMaxBytes); err != nil {
			return fmt.Errorf("result: %w", err)
		}
	}
	return nil
}

func validateJSONMergeInput(input map[string]any, options InputValidationOptions) error {
	leftRaw, leftPresent := input["a"]
	rightRaw, rightPresent := input["b"]
	leftDeferred := leftPresent && isDeferredWholeTemplate(leftRaw, options)
	rightDeferred := rightPresent && isDeferredWholeTemplate(rightRaw, options)
	if leftPresent && !leftDeferred {
		if err := validateBoundedJSONValue(leftRaw, jsonToolMaxBytes); err != nil {
			return fmt.Errorf("a: %w", err)
		}
	}
	if rightPresent && !rightDeferred {
		if err := validateBoundedJSONValue(rightRaw, jsonToolMaxBytes); err != nil {
			return fmt.Errorf("b: %w", err)
		}
	}
	if leftPresent && rightPresent && !leftDeferred && !rightDeferred {
		result := deepMerge(leftRaw.(map[string]any), rightRaw.(map[string]any))
		if err := validateBoundedJSONValue(result, jsonToolMaxBytes); err != nil {
			return fmt.Errorf("result: %w", err)
		}
	}
	return nil
}

func jsonTools() []Definition {
	return []Definition{
		{
			Name:         "json.parse",
			Description:  "Parse a JSON string into its native object, array, or primitive value.",
			Required:     []string{"value"},
			Fields:       []Field{{Name: "value", Type: "string", Required: true}},
			InputExample: map[string]any{"value": `{"customer":{"id":42}}`},
			Validate:     validateJSONParseInput,
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				text, ok := input["value"].(string)
				if !ok {
					return nil, fmt.Errorf("json.parse received invalid JSON")
				}
				var parsed any
				if err := json.Unmarshal([]byte(text), &parsed); err != nil {
					return nil, fmt.Errorf("json.parse received invalid JSON")
				}
				return map[string]any{"value": parsed}, nil
			},
		},
		{
			Name:         "json.pick",
			Description:  "Pick a value from workflow context using a dot path.",
			Required:     []string{"path"},
			Optional:     []string{"source"},
			Fields:       []Field{{Name: "path", Type: "string", Required: true}, {Name: "source", Type: "object"}},
			InputExample: map[string]any{"path": "fetch.output.statusCode"},
			Validate:     validateJSONPickInput,
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				path, _ := input["path"].(string)
				return map[string]any{"value": pickByPath(input["source"], path)}, nil
			},
		},
		{
			Name:        "json.set",
			Description: "Return a copy of `source` with `value` set at the dotted `path`.",
			Required:    []string{"path", "value"},
			Optional:    []string{"source"},
			Fields: []Field{
				{Name: "path", Type: "string", Required: true},
				{Name: "value", Type: "unknown", Required: true},
				{Name: "source", Type: "object"},
			},
			InputExample: map[string]any{
				"source": map[string]any{"user": map[string]any{"id": 1}},
				"path":   "user.name", "value": "Ada",
			},
			Validate: validateJSONSetInput,
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				path, _ := input["path"].(string)
				value, err := setByPath(input["source"], path, input["value"])
				if err != nil {
					return nil, err
				}
				return map[string]any{"value": value}, nil
			},
		},
		{
			Name:        "json.merge",
			Description: "Deep-merge two objects; `b` wins on key conflicts. Arrays are replaced wholesale.",
			Required:    []string{"a", "b"},
			Fields: []Field{
				{Name: "a", Type: "object", Required: true},
				{Name: "b", Type: "object", Required: true},
			},
			InputExample: map[string]any{
				"a": map[string]any{"user": map[string]any{"id": 1}},
				"b": map[string]any{"user": map[string]any{"name": "Ada"}},
			},
			Validate: validateJSONMergeInput,
			Execute: func(_ context.Context, input map[string]any) (map[string]any, error) {
				left, _ := input["a"].(map[string]any)
				right, _ := input["b"].(map[string]any)
				return map[string]any{"value": deepMerge(left, right)}, nil
			},
		},
	}
}

func pickByPath(source any, path string) any {
	current := source
	for segment := range strings.SplitSeq(path, ".") {
		if segment == "" {
			continue
		}
		switch container := current.(type) {
		case map[string]any:
			value, ok := container[segment]
			if !ok {
				return nil
			}
			current = value
		case []any:
			index, err := strconv.Atoi(segment)
			if err != nil || index < 0 || index >= len(container) {
				return nil
			}
			current = container[index]
		default:
			return nil
		}
	}
	return current
}

func setByPath(source any, path string, value any) (any, error) {
	if err := validateJSONPath(path); err != nil {
		return nil, err
	}
	segments := []string{}
	for segment := range strings.SplitSeq(path, ".") {
		if segment != "" {
			segments = append(segments, segment)
		}
	}
	if len(segments) == 0 {
		return source, nil
	}
	for _, segment := range segments {
		if prototypeKeys[segment] {
			return nil, fmt.Errorf("json.set refuses prototype-targeting path segments: %s", path)
		}
	}
	root := map[string]any{}
	if existing, ok := source.(map[string]any); ok {
		maps.Copy(root, existing)
	}
	cursor := root
	for _, segment := range segments[:len(segments)-1] {
		next := map[string]any{}
		if existing, ok := cursor[segment].(map[string]any); ok {
			maps.Copy(next, existing)
		}
		cursor[segment] = next
		cursor = next
	}
	cursor[segments[len(segments)-1]] = value
	return root, nil
}

func deepMerge(left, right map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range left {
		if !prototypeKeys[key] {
			out[key] = value
		}
	}
	for key, value := range right {
		if prototypeKeys[key] {
			continue
		}
		leftValue, leftIsMap := out[key].(map[string]any)
		rightValue, rightIsMap := value.(map[string]any)
		if leftIsMap && rightIsMap {
			out[key] = deepMerge(leftValue, rightValue)
			continue
		}
		out[key] = value
	}
	return out
}
