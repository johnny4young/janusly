package httpapi

import (
	"encoding/json"
	"maps"
	"slices"
	"strconv"
	"strings"

	"github.com/johnny4young/janusly/internal/domain"
)

// Fields domain.Parse decodes into typed Go values. A kind mismatch there fails
// the whole decode with toolchain-specific text that names only the first one.
var (
	workflowStringFields = []string{"dslVersion", "id", "name", "templatePolicy"}
	workflowObjectFields = []string{"inputs", "recovery"}
	nodeStringFields     = []string{"id", "type", "label"}
	edgeStringFields     = []string{"id", "from", "to", "condition"}
)

// mistypedFieldIssues reports every typed-field kind mismatch by structural
// path and returns a copy without those values, so Parse can check the rest.
func mistypedFieldIssues(document map[string]any) (map[string]any, []domain.Issue, []string) {
	var issues []domain.Issue
	var removed []string
	report := func(path, want string, value any) {
		issues = append(issues, domain.Issue{
			Code:    domain.CodeInvalidContract,
			Message: path + ": expected " + want + ", received " + jsonKind(value),
		})
		removed = append(removed, path)
	}
	clean := maps.Clone(document)
	checkFields(clean, "", workflowStringFields, "string", report)
	checkFields(clean, "", workflowObjectFields, "object", report)
	if recovery, ok := clean["recovery"].(map[string]any); ok {
		recovery = maps.Clone(recovery)
		clean["recovery"] = recovery
		checkFields(recovery, "recovery.", []string{"contract"}, "object", report)
	}
	if outputs, present := clean["outputs"]; present && outputs != nil {
		if object, ok := outputs.(map[string]any); !ok {
			report("outputs", "object", outputs)
			delete(clean, "outputs")
		} else {
			object = maps.Clone(object)
			clean["outputs"] = object
			for _, key := range slices.Sorted(maps.Keys(object)) {
				if value := object[key]; value != nil && !isKind(value, "string") {
					report("outputs."+key, "string", value)
					delete(object, key)
				}
			}
		}
	}
	checkElements(clean, "nodes", nodeStringFields, report, func(element map[string]any, prefix string) {
		if config, present := element["config"]; present && config != nil && !isKind(config, "object") {
			report(prefix+"config", "object", config)
			delete(element, "config")
		}
	})
	checkElements(clean, "edges", edgeStringFields, report, func(element map[string]any, prefix string) {
		if onError, present := element["onError"]; present && onError != nil && !isKind(onError, "boolean") {
			report(prefix+"onError", "boolean", onError)
			delete(element, "onError")
		}
	})
	return clean, issues, removed
}

func checkFields(object map[string]any, prefix string, fields []string, want string, report func(string, string, any)) {
	for _, field := range fields {
		if value, present := object[field]; present && value != nil && !isKind(value, want) {
			report(prefix+field, want, value)
			delete(object, field)
		}
	}
}

// checkElements leaves a non-object element in place: Parse then reports it
// under the same structural path, without any kind text of its own.
func checkElements(document map[string]any, field string, stringFields []string,
	report func(string, string, any), extra func(map[string]any, string)) {
	value, present := document[field]
	if !present || value == nil {
		return
	}
	elements, ok := value.([]any)
	if !ok {
		report(field, "array", value)
		delete(document, field)
		return
	}
	elements = append([]any(nil), elements...)
	document[field] = elements
	for index, raw := range elements {
		element, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		element = maps.Clone(element)
		elements[index] = element
		prefix := field + "." + strconv.Itoa(index) + "."
		checkFields(element, prefix, stringFields, "string", report)
		extra(element, prefix)
	}
}

// parseFailureIssues replaces the decoder's single, toolchain-worded type
// error with every structural mismatch, then reports what else Parse finds.
func parseFailureIssues(raw []byte, parseIssues []domain.Issue) []domain.Issue {
	var document map[string]any
	if json.Unmarshal(raw, &document) != nil || document == nil {
		return parseIssues
	}
	clean, kindIssues, removed := mistypedFieldIssues(document)
	if len(kindIssues) == 0 {
		return withIssuesBehindParseErrors(raw, parseIssues)
	}
	cleanRaw, err := json.Marshal(clean)
	if err != nil {
		return append(kindIssues, parseIssues...)
	}
	var rest []domain.Issue
	if workflow, cleanIssues := domain.Parse(cleanRaw); workflow != nil {
		rest = draftBlockingIssues(workflow)
	} else {
		rest = withIssuesBehindParseErrors(cleanRaw, cleanIssues)
	}
	issues := kindIssues
	for _, issue := range rest {
		if !derivedFromRemovedField(issue, removed) {
			issues = append(issues, issue)
		}
	}
	return issues
}

// Parse messages start with their field path; a removed value's own
// "required" or "invalid" report is not an independent defect.
func derivedFromRemovedField(issue domain.Issue, removed []string) bool {
	for _, path := range removed {
		if strings.HasPrefix(issue.Message, path+":") || strings.HasPrefix(issue.Message, path+".") {
			return true
		}
	}
	return false
}

func isKind(value any, want string) bool { return jsonKind(value) == want }

func jsonKind(value any) string {
	switch value.(type) {
	case string:
		return "string"
	case float64, json.Number:
		return "number"
	case bool:
		return "boolean"
	case map[string]any:
		return "object"
	case []any:
		return "array"
	case nil:
		return "null"
	default:
		return "unknown"
	}
}
