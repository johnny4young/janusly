// Limited-grammar expression evaluator for condition nodes and edge
// condition strings, implements the contract's zero-dependency
// recursive-descent parser: boolean composition (||, &&, !, parens),
// comparisons (===, !==, ==, !=, >, <, >=, <=), string/collection operators
// (contains, startsWith, matches, in), boolean/number/string/array literals,
// null, and dotted paths rooted at context. or inputs.
//
// The evaluator never does template substitution — template values resolve
// before an expression is evaluated. Don't expand the grammar without
// updating the generation system prompt that publishes it to the LLM.
package grammar

import (
	"fmt"
	"math"
	"regexp"
	"strings"
)

// Scope carries the two path roots an expression may read.
type Scope struct {
	Context any
	Inputs  any
}

// ValidationResult mirrors the contract's wire shape for authoring-side
// validation; Code is one of empty_expression, empty_value,
// unsupported_token, invalid_expression.
type ValidationResult struct {
	Valid   bool
	Message string
	Code    string
	Token   string
}

var comparisonOperators = []string{
	"===", "!==", ">=", "<=", "==", "!=", ">", "<",
	"contains", "startsWith", "matches", "in",
}

var wordComparisonOperators = map[string]bool{
	"contains": true, "startsWith": true, "matches": true, "in": true,
}

const (
	maxGlobPatternChars = 256
	maxGlobValueChars   = 16_384
)

var safePathPattern = regexp.MustCompile(`^(context|inputs)(\.[A-Za-z0-9_$-]+|\[\d+\])*$`)
var numberLiteralPattern = regexp.MustCompile(`^-?\d+(\.\d+)?$`)
var pathIndexPattern = regexp.MustCompile(`\[(\d+)\]`)

// EvaluateExpression evaluates against the scope and coerces to boolean.
// Errors surface grammar or evaluation problems so callers can either show
// them (validation path) or treat the edge as falsy with logging.
func EvaluateExpression(expression string, scope Scope) (bool, error) {
	return evaluateInternal(expression, scope, false)
}

// ValidateExpression static-evaluates against empty scopes to surface
// syntactic and contract errors, mapping them to the contract's codes.
func ValidateExpression(expression string) ValidationResult {
	_, err := evaluateInternal(expression, Scope{Context: map[string]any{}, Inputs: map[string]any{}}, true)
	if err == nil {
		return ValidationResult{Valid: true}
	}
	message := err.Error()
	switch {
	case message == "Expression cannot be empty":
		return ValidationResult{Message: message, Code: "empty_expression"}
	case message == "Expression value cannot be empty":
		return ValidationResult{Message: message, Code: "empty_value"}
	case strings.HasPrefix(message, "Unsupported expression token: "):
		return ValidationResult{
			Message: message, Code: "unsupported_token",
			Token: strings.TrimPrefix(message, "Unsupported expression token: "),
		}
	default:
		return ValidationResult{Message: message, Code: "invalid_expression"}
	}
}

// DomainValidator adapts ValidateExpression to the domain package's
// injectable seam: (valid, message).
func DomainValidator(expression string) (bool, string) {
	result := ValidateExpression(expression)
	return result.Valid, result.Message
}

func evaluateInternal(expression string, scope Scope, validateOnly bool) (bool, error) {
	trimmed := stripOuterParens(strings.TrimSpace(expression))
	if trimmed == "" {
		return false, fmt.Errorf("Expression cannot be empty")
	}
	value, err := evaluateBoolean(trimmed, scope, validateOnly)
	if err != nil {
		return false, err
	}
	return jsTruthy(value), nil
}

func evaluateBoolean(expression string, scope Scope, validateOnly bool) (any, error) {
	if orParts := splitTopLevel(expression, "||"); len(orParts) > 1 {
		// Static validation must visit every branch: runtime short-circuiting
		// would otherwise hide an invalid contract behind `true || ...`.
		result := false
		for _, part := range orParts {
			v, err := evaluateBoolean(part, scope, validateOnly)
			if err != nil {
				return nil, err
			}
			if jsTruthy(v) {
				result = true
				if !validateOnly {
					return true, nil
				}
			}
		}
		return result, nil
	}

	if andParts := splitTopLevel(expression, "&&"); len(andParts) > 1 {
		result := true
		for _, part := range andParts {
			v, err := evaluateBoolean(part, scope, validateOnly)
			if err != nil {
				return nil, err
			}
			if !jsTruthy(v) {
				result = false
				if !validateOnly {
					return false, nil
				}
			}
		}
		return result, nil
	}

	trimmed := stripOuterParens(strings.TrimSpace(expression))
	if strings.HasPrefix(trimmed, "!") {
		inner, err := evaluateBoolean(trimmed[1:], scope, validateOnly)
		if err != nil {
			return nil, err
		}
		return !jsTruthy(inner), nil
	}
	if trimmed == "true" {
		return true, nil
	}
	if trimmed == "false" {
		return false, nil
	}

	for _, operator := range comparisonOperators {
		parts := splitComparison(trimmed, operator)
		if parts == nil {
			continue
		}
		left, err := readValue(parts[0], scope)
		if err != nil {
			return nil, err
		}
		right, err := readValue(parts[1], scope)
		if err != nil {
			return nil, err
		}
		switch operator {
		case "===":
			return strictEquals(left, right), nil
		case "!==":
			return !strictEquals(left, right), nil
		case "==":
			return looseEquals(left, right), nil
		case "!=":
			return !looseEquals(left, right), nil
		case ">", "<", ">=", "<=":
			return compareOrdered(left, right, operator, validateOnly)
		case "contains":
			return containsValue(left, right, validateOnly)
		case "startsWith":
			return startsWithValue(left, right, validateOnly)
		case "matches":
			return matchesValue(left, right, validateOnly)
		case "in":
			return isValueIn(left, right, validateOnly)
		}
	}

	return readValue(trimmed, scope)
}

func readValue(token string, scope Scope) (any, error) {
	trimmed := stripOuterParens(strings.TrimSpace(token))
	if trimmed == "" {
		return nil, fmt.Errorf("Expression value cannot be empty")
	}
	switch trimmed {
	case "true":
		return true, nil
	case "false":
		return false, nil
	case "null":
		return nil, nil
	}

	if strings.HasPrefix(trimmed, "[") && strings.HasSuffix(trimmed, "]") {
		inner := strings.TrimSpace(trimmed[1 : len(trimmed)-1])
		if inner == "" {
			return []any{}, nil
		}
		items := splitTopLevel(inner, ",")
		out := make([]any, 0, len(items))
		for _, item := range items {
			parsed, err := readPrimitiveArrayItem(item)
			if err != nil {
				return nil, err
			}
			out = append(out, parsed)
		}
		return out, nil
	}

	if numberLiteralPattern.MatchString(trimmed) {
		return jsNumber(trimmed), nil
	}

	if isQuoted(trimmed) {
		return trimmed[1 : len(trimmed)-1], nil
	}

	if safePathPattern.MatchString(trimmed) {
		return getBySafePath(scope, trimmed), nil
	}

	return nil, fmt.Errorf("Unsupported expression token: %s", trimmed)
}

// readPrimitiveArrayItem parses one published primitive-array item; paths
// and nested arrays stay out of the grammar.
func readPrimitiveArrayItem(token string) (any, error) {
	trimmed := stripOuterParens(strings.TrimSpace(token))
	switch trimmed {
	case "true":
		return true, nil
	case "false":
		return false, nil
	case "null":
		return nil, nil
	}
	if numberLiteralPattern.MatchString(trimmed) {
		return jsNumber(trimmed), nil
	}
	if isQuoted(trimmed) {
		return trimmed[1 : len(trimmed)-1], nil
	}
	return nil, fmt.Errorf("Unsupported expression token: %s", trimmed)
}

func isQuoted(s string) bool {
	return len(s) >= 2 &&
		((strings.HasPrefix(s, `"`) && strings.HasSuffix(s, `"`)) ||
			(strings.HasPrefix(s, "'") && strings.HasSuffix(s, "'")))
}

func compareOrdered(left, right any, operator string, validateOnly bool) (any, error) {
	// Unresolved paths are expected while validation runs against empty
	// scopes. A known boolean/null/array partner still proves the contract
	// invalid; two unknown paths remain syntactically valid.
	if isUndefined(left) || isUndefined(right) {
		known := left
		if isUndefined(left) {
			known = right
		}
		if validateOnly && !isUndefined(known) {
			if _, isNum := known.(float64); !isNum {
				if _, isStr := known.(string); !isStr {
					return nil, fmt.Errorf("Ordered comparison %s requires two numbers or two strings", operator)
				}
			}
		}
		return false, nil
	}

	var comparison float64
	lNum, lIsNum := left.(float64)
	rNum, rIsNum := right.(float64)
	lStr, lIsStr := left.(string)
	rStr, rIsStr := right.(string)
	switch {
	case lIsNum && rIsNum:
		if !isFinite(lNum) || !isFinite(rNum) {
			if validateOnly {
				return nil, fmt.Errorf("Ordered comparison %s requires finite numbers", operator)
			}
			return false, nil
		}
		comparison = lNum - rNum
	case lIsStr && rIsStr:
		// Relational string order is UTF-16 code-unit order, which also
		// makes equal-width ISO timestamps comparable.
		comparison = float64(utf16Compare(lStr, rStr))
	default:
		// Historical mixed numeric-string coercion; booleans, objects, null
		// and non-numeric strings refuse instead of comparing NaN.
		leftNumber, rightNumber := coerceOrderedNumber(left), coerceOrderedNumber(right)
		if !isFinite(leftNumber) || !isFinite(rightNumber) {
			if validateOnly {
				return nil, fmt.Errorf("Ordered comparison %s requires two numbers or two strings", operator)
			}
			return false, nil
		}
		comparison = leftNumber - rightNumber
	}

	switch operator {
	case ">":
		return comparison > 0, nil
	case "<":
		return comparison < 0, nil
	case ">=":
		return comparison >= 0, nil
	default:
		return comparison <= 0, nil
	}
}

func coerceOrderedNumber(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case string:
		return jsNumber(t)
	default:
		return nan()
	}
}

func containsValue(left, right any, validateOnly bool) (any, error) {
	if isUndefined(left) || isUndefined(right) {
		return false, nil
	}
	if l, ok := left.(string); ok {
		if r, ok := right.(string); ok {
			return strings.Contains(l, r), nil
		}
	}
	if l, ok := left.([]any); ok {
		for _, item := range l {
			if strictEquals(item, right) {
				return true, nil
			}
		}
		return false, nil
	}
	if validateOnly {
		return nil, fmt.Errorf("contains requires a string or array on the left")
	}
	return false, nil
}

func startsWithValue(left, right any, validateOnly bool) (any, error) {
	if isUndefined(left) || isUndefined(right) {
		known := left
		if isUndefined(left) {
			known = right
		}
		if validateOnly && !isUndefined(known) {
			if _, ok := known.(string); !ok {
				return nil, fmt.Errorf("startsWith requires two strings")
			}
		}
		return false, nil
	}
	if l, ok := left.(string); ok {
		if r, ok := right.(string); ok {
			return strings.HasPrefix(l, r), nil
		}
	}
	if validateOnly {
		return nil, fmt.Errorf("startsWith requires two strings")
	}
	return false, nil
}

func matchesValue(left, right any, validateOnly bool) (any, error) {
	if validateOnly {
		if l, ok := left.(string); ok && len(l) > maxGlobValueChars {
			return nil, fmt.Errorf("matches value exceeds %d characters", maxGlobValueChars)
		}
		if r, ok := right.(string); ok && len(r) > maxGlobPatternChars {
			return nil, fmt.Errorf("matches pattern exceeds %d characters", maxGlobPatternChars)
		}
	}
	if isUndefined(left) || isUndefined(right) {
		known := left
		if isUndefined(left) {
			known = right
		}
		if validateOnly && !isUndefined(known) {
			if _, ok := known.(string); !ok {
				return nil, fmt.Errorf("matches requires a string value and a glob pattern")
			}
		}
		return false, nil
	}
	l, lOK := left.(string)
	r, rOK := right.(string)
	if !lOK || !rOK {
		if validateOnly {
			return nil, fmt.Errorf("matches requires a string value and a glob pattern")
		}
		return false, nil
	}
	return matchesGlob(l, r)
}

func isValueIn(left, right any, validateOnly bool) (any, error) {
	// The right operand owns the operator contract, so validate it even when
	// the left path is unresolved in the empty static-validation scope.
	if isUndefined(right) {
		return false, nil
	}
	arr, ok := right.([]any)
	if !ok {
		if validateOnly {
			return nil, fmt.Errorf("in requires an array on the right")
		}
		return false, nil
	}
	if isUndefined(left) {
		return false, nil
	}
	for _, item := range arr {
		if strictEquals(item, left) {
			return true, nil
		}
	}
	return false, nil
}

// matchesGlob is the bounded whole-string glob matcher (`*` any run, `?`
// one character), linear via the classic backtracking-pointer walk.
func matchesGlob(value, pattern string) (bool, error) {
	if len(pattern) > maxGlobPatternChars {
		return false, fmt.Errorf("matches pattern exceeds %d characters", maxGlobPatternChars)
	}
	if len(value) > maxGlobValueChars {
		return false, fmt.Errorf("matches value exceeds %d characters", maxGlobValueChars)
	}

	valueIndex, patternIndex := 0, 0
	starIndex, starValueIndex := -1, 0
	for valueIndex < len(value) {
		var patternChar byte
		if patternIndex < len(pattern) {
			patternChar = pattern[patternIndex]
		}
		switch {
		case patternIndex < len(pattern) && (patternChar == '?' || patternChar == value[valueIndex]):
			patternIndex++
			valueIndex++
		case patternIndex < len(pattern) && patternChar == '*':
			starIndex = patternIndex
			patternIndex++
			starValueIndex = valueIndex
		case starIndex >= 0:
			patternIndex = starIndex + 1
			starValueIndex++
			valueIndex = starValueIndex
		default:
			return false, nil
		}
	}
	for patternIndex < len(pattern) && pattern[patternIndex] == '*' {
		patternIndex++
	}
	return patternIndex == len(pattern), nil
}

func splitComparison(expression, operator string) []string {
	var parts []string
	if wordComparisonOperators[operator] {
		parts = splitWordComparison(expression, operator)
	} else {
		parts = splitTopLevel(expression, operator)
	}
	if len(parts) != 2 {
		return nil
	}
	return parts
}

// splitWordComparison splits on a word operator only when it sits at depth
// zero with whitespace on both sides — so paths or strings containing the
// word never split.
func splitWordComparison(expression, operator string) []string {
	var parts []string
	parenDepth, bracketDepth := 0, 0
	var quote byte
	start := 0

	for i := 0; i < len(expression); i++ {
		char := expression[i]
		if (char == '"' || char == '\'') && !isEscaped(expression, i) {
			switch quote {
			case char:
				quote = 0
			case 0:
				quote = char
			}
			continue
		}
		if quote != 0 {
			continue
		}
		switch char {
		case '(':
			parenDepth++
		case ')':
			parenDepth--
		case '[':
			bracketDepth++
		case ']':
			bracketDepth--
		}

		if parenDepth == 0 && bracketDepth == 0 &&
			i > 0 && i+len(operator) < len(expression) &&
			expression[i:i+len(operator)] == operator &&
			isSpaceByte(expression[i-1]) && isSpaceByte(expression[i+len(operator)]) {
			parts = append(parts, strings.TrimSpace(expression[start:i]))
			start = i + len(operator)
			i += len(operator) - 1
		}
	}
	if len(parts) == 0 {
		return []string{strings.TrimSpace(expression)}
	}
	parts = append(parts, strings.TrimSpace(expression[start:]))
	return parts
}

func splitTopLevel(expression, operator string) []string {
	var parts []string
	parenDepth, bracketDepth := 0, 0
	var quote byte
	start := 0

	for i := 0; i < len(expression); i++ {
		char := expression[i]
		if (char == '"' || char == '\'') && !isEscaped(expression, i) {
			switch quote {
			case char:
				quote = 0
			case 0:
				quote = char
			}
			continue
		}
		if quote != 0 {
			continue
		}
		switch char {
		case '(':
			parenDepth++
		case ')':
			parenDepth--
		case '[':
			bracketDepth++
		case ']':
			bracketDepth--
		}

		if parenDepth == 0 && bracketDepth == 0 &&
			i+len(operator) <= len(expression) &&
			expression[i:i+len(operator)] == operator {
			parts = append(parts, strings.TrimSpace(expression[start:i]))
			start = i + len(operator)
			i += len(operator) - 1
		}
	}
	if len(parts) == 0 {
		return []string{strings.TrimSpace(expression)}
	}
	parts = append(parts, strings.TrimSpace(expression[start:]))
	return parts
}

func isEscaped(value string, index int) bool {
	backslashes := 0
	for cursor := index - 1; cursor >= 0 && value[cursor] == '\\'; cursor-- {
		backslashes++
	}
	return backslashes%2 == 1
}

func isSpaceByte(b byte) bool {
	return b == ' ' || b == '\t' || b == '\n' || b == '\r' || b == '\f' || b == '\v'
}

func stripOuterParens(expression string) string {
	current := expression
	for strings.HasPrefix(current, "(") && strings.HasSuffix(current, ")") && wrapsWholeExpression(current) {
		current = strings.TrimSpace(current[1 : len(current)-1])
	}
	return current
}

func wrapsWholeExpression(expression string) bool {
	depth := 0
	var quote byte
	for i := 0; i < len(expression); i++ {
		char := expression[i]
		if (char == '"' || char == '\'') && !isEscaped(expression, i) {
			switch quote {
			case char:
				quote = 0
			case 0:
				quote = char
			}
			continue
		}
		if quote != 0 {
			continue
		}
		if char == '(' {
			depth++
		}
		if char == ')' {
			depth--
		}
		if depth == 0 && i < len(expression)-1 {
			return false
		}
	}
	return depth == 0
}

// getBySafePath resolves a validated context./inputs. path; any absent link
// yields undefined, matching JS optional traversal.
func getBySafePath(scope Scope, path string) any {
	normalized := pathIndexPattern.ReplaceAllString(path, ".$1")
	segments := strings.Split(normalized, ".")
	var current any
	switch segments[0] {
	case "context":
		current = scope.Context
	case "inputs":
		current = scope.Inputs
	default:
		return undef
	}
	for _, key := range segments[1:] {
		current = childValue(current, key)
		if isUndefined(current) {
			return undef
		}
	}
	return current
}

// childValue reads one path segment from a map or a slice (numeric key),
// mirroring JS property access where array indices are own properties.
func childValue(parent any, key string) any {
	switch p := parent.(type) {
	case map[string]any:
		v, ok := p[key]
		if !ok {
			return undef
		}
		return v
	case []any:
		index, err := parseIndex(key)
		if err != nil || index < 0 || index >= len(p) {
			return undef
		}
		return p[index]
	default:
		return undef
	}
}

func parseIndex(key string) (int, error) {
	if key == "" {
		return 0, fmt.Errorf("empty index")
	}
	n := 0
	for _, c := range key {
		if c < '0' || c > '9' {
			return 0, fmt.Errorf("non-numeric index")
		}
		n = n*10 + int(c-'0')
		if n > 1<<30 {
			return 0, fmt.Errorf("index overflow")
		}
	}
	return n, nil
}

func nan() float64 {
	return math.NaN()
}

func isFinite(f float64) bool {
	return !math.IsNaN(f) && !math.IsInf(f, 0)
}
