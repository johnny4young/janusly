// JavaScript value semantics over the JSON domain. The contract evaluator
// runs on JS values, so porting the grammar faithfully means porting the
// coercions it leans on: undefined-versus-null, truthiness, Number(),
// String() and UTF-16 relational string order. Kept in one file so every
// coercion decision is auditable against the contract in one place.
package grammar

import (
	"math"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf16"
)

// undefinedValue distinguishes an unresolved path (JS undefined) from an
// explicit null; the two behave differently in equality and coercions.
type undefinedValue struct{}

// undef is the singleton undefined marker.
var undef = undefinedValue{}

func isUndefined(v any) bool {
	_, ok := v.(undefinedValue)
	return ok
}

// jsTruthy mirrors Boolean(v): false for undefined, null, false, 0, NaN and
// ""; true for everything else, including empty arrays and objects.
func jsTruthy(v any) bool {
	switch t := v.(type) {
	case undefinedValue:
		return false
	case nil:
		return false
	case bool:
		return t
	case float64:
		return t != 0 && !math.IsNaN(t)
	case string:
		return t != ""
	default:
		return true
	}
}

// strictEquals mirrors ===. Arrays and objects compare by reference in JS;
// after a JSON round trip no two Go values share identity, so non-scalar
// operands compare unequal here (an accepted divergence — the only JS shape
// it changes is comparing a path to itself).
func strictEquals(left, right any) bool {
	if isUndefined(left) || isUndefined(right) {
		return isUndefined(left) && isUndefined(right)
	}
	switch l := left.(type) {
	case nil:
		return right == nil
	case bool:
		r, ok := right.(bool)
		return ok && l == r
	case float64:
		r, ok := right.(float64)
		return ok && l == r
	case string:
		r, ok := right.(string)
		return ok && l == r
	default:
		return false
	}
}

// looseEquals mirrors == for the scalar domain: null and undefined equate
// with each other only; booleans coerce to numbers; a number-versus-string
// pair coerces the string through Number(). Array and object operands return
// false (JS would ToPrimitive them; nothing in the workflow corpus relies on
// that, and refusing beats guessing).
func looseEquals(left, right any) bool {
	lNilish := left == nil || isUndefined(left)
	rNilish := right == nil || isUndefined(right)
	if lNilish || rNilish {
		return lNilish && rNilish
	}
	if l, ok := left.(bool); ok {
		return looseEquals(boolToNumber(l), right)
	}
	if r, ok := right.(bool); ok {
		return looseEquals(left, boolToNumber(r))
	}
	switch l := left.(type) {
	case float64:
		switch r := right.(type) {
		case float64:
			return l == r
		case string:
			return numbersEqual(l, jsNumber(r))
		}
	case string:
		switch r := right.(type) {
		case string:
			return l == r
		case float64:
			return numbersEqual(jsNumber(l), r)
		}
	}
	return false
}

func numbersEqual(a, b float64) bool {
	if math.IsNaN(a) || math.IsNaN(b) {
		return false
	}
	return a == b
}

func boolToNumber(b bool) float64 {
	if b {
		return 1
	}
	return 0
}

var jsDecimalPattern = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$`)

// jsNumber mirrors Number(string): trimmed empty is 0, Infinity spellings
// resolve, 0x/0o/0b radix literals parse, and anything outside the decimal
// grammar is NaN (so Go-isms like "inf" or "0x1p3" don't sneak in).
func jsNumber(s string) float64 {
	t := strings.TrimSpace(s)
	if t == "" {
		return 0
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(t) > 2 && t[0] == '0' {
		var base int
		switch t[1] {
		case 'x', 'X':
			base = 16
		case 'o', 'O':
			base = 8
		case 'b', 'B':
			base = 2
		}
		if base != 0 {
			if n, err := strconv.ParseUint(t[2:], base, 64); err == nil {
				return float64(n)
			}
			return math.NaN()
		}
	}
	if !jsDecimalPattern.MatchString(t) {
		return math.NaN()
	}
	n, err := strconv.ParseFloat(t, 64)
	if err != nil {
		return math.NaN()
	}
	return n
}

// jsString mirrors String(v) for scalar interpolation: integral numbers
// render without a decimal point, and booleans/null follow JS spellings.
// Extreme magnitudes may format differently than V8's shortest-round-trip
// algorithm — an accepted divergence recorded in the plan.
func jsString(v any) string {
	switch t := v.(type) {
	case string:
		return t
	case bool:
		if t {
			return "true"
		}
		return "false"
	case float64:
		if math.IsNaN(t) {
			return "NaN"
		}
		if math.IsInf(t, 1) {
			return "Infinity"
		}
		if math.IsInf(t, -1) {
			return "-Infinity"
		}
		if t == math.Trunc(t) && math.Abs(t) < 1e21 {
			return strconv.FormatFloat(t, 'f', -1, 64)
		}
		return strconv.FormatFloat(t, 'g', -1, 64)
	default:
		return ""
	}
}

// utf16Compare mirrors JS relational string order: code-unit order, which
// also makes equal-width ISO timestamps comparable. It differs from Go's
// code-point order only when supplementary-plane characters meet the
// U+E000–U+FFFF range.
func utf16Compare(a, b string) int {
	ua := utf16.Encode([]rune(a))
	ub := utf16.Encode([]rune(b))
	for i := 0; i < len(ua) && i < len(ub); i++ {
		if ua[i] != ub[i] {
			if ua[i] < ub[i] {
				return -1
			}
			return 1
		}
	}
	switch {
	case len(ua) < len(ub):
		return -1
	case len(ua) > len(ub):
		return 1
	default:
		return 0
	}
}
