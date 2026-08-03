/**
 * Limited-grammar expression evaluator used by `condition` nodes and edge
 * `condition` strings. Recursive-descent parser over a tiny grammar:
 * boolean composition (`||`, `&&`, `!`, parens), comparisons (`===`, `!==`,
 * `==`, `!=`, `>`, `<`, `>=`, `<=`), string/collection operators
 * (`contains`, `startsWith`, `matches`, `in`), boolean / number / string / array
 * literals, `null`, and dotted paths starting with `context.` or `inputs.`.
 *
 * Used by the engine (`condition` executor + edge guard), API workflow
 * sanitization, and the web Inspector's branch-rule editor. Keeping this
 * parser zero-dependency lets authoring validate the exact runtime grammar
 * without shipping a duplicate implementation.
 *
 * Invariants:
 * - Don't expand the grammar without updating
 *   `apps/api/src/ai-prompts.ts:GENERATE_WORKFLOW_SYSTEM_PROMPT` so the
 *   LLM knows what's emittable. The grammar is published in the system
 *   prompt.
 * - The evaluator must NEVER do template substitution. Template values
 *   resolve before `evaluateExpression` is called.
 */

type ExpressionScope = Record<string, unknown>;

export type ExpressionValidationCode =
  | "empty_expression"
  | "empty_value"
  | "unsupported_token"
  | "invalid_expression";

export type ExpressionValidationResult =
  | { valid: true; message: null; code: null }
  | { valid: false; message: string; code: ExpressionValidationCode; token?: string };

const comparisonOperators = [
  "===",
  "!==",
  ">=",
  "<=",
  "==",
  "!=",
  ">",
  "<",
  "contains",
  "startsWith",
  "matches",
  "in",
] as const;
type ComparisonOperator = (typeof comparisonOperators)[number];
export const SIMPLE_COMPARISON_OPERATORS = ["===", "!==", ">", ">=", "<", "<="] as const;
export type SimpleComparisonOperator = (typeof SIMPLE_COMPARISON_OPERATORS)[number];
export type SimpleExpressionPrimitive = string | number | boolean;
export type SimpleComparisonExpression = {
  left: string;
  operator: SimpleComparisonOperator;
  right: SimpleExpressionPrimitive;
};

const wordComparisonOperators = new Set<ComparisonOperator>(["contains", "startsWith", "matches", "in"]);
const MAX_GLOB_PATTERN_CHARS = 256;
const MAX_GLOB_VALUE_CHARS = 16_384;
const safePathPattern = /^(context|inputs)(\.[A-Za-z0-9_$-]+|\[\d+\])*$/;
const simpleComparisonPattern = /^((?:context|inputs)(?:\.[A-Za-z0-9_$-]+|\[\d+\])*)\s*(===|!==|>=|<=|>|<)\s*(true|false|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*")$/;

/**
 * Static-evaluate the expression with empty scopes to surface syntactic /
 * grammar errors. Returns `{ valid: false, message }` on any throw.
 */
export function validateExpression(expression: string): ExpressionValidationResult {
  try {
    evaluateExpressionInternal(expression, { context: {}, inputs: {} }, true);
    return { valid: true, message: null, code: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid expression";
    if (message === "Expression cannot be empty") {
      return { valid: false, message, code: "empty_expression" };
    }
    if (message === "Expression value cannot be empty") {
      return { valid: false, message, code: "empty_value" };
    }
    const unsupportedPrefix = "Unsupported expression token: ";
    if (message.startsWith(unsupportedPrefix)) {
      return {
        valid: false,
        message,
        code: "unsupported_token",
        token: message.slice(unsupportedPrefix.length),
      };
    }
    return { valid: false, message, code: "invalid_expression" };
  }
}

/**
 * Project the common one-path-versus-one-literal subset used by guided
 * authoring. Complex boolean expressions remain valid runtime expressions,
 * but deliberately return `null` so callers preserve them in their advanced
 * editor instead of attempting a lossy round trip.
 */
export function parseSimpleComparisonExpression(expression: string): SimpleComparisonExpression | null {
  const trimmed = stripOuterParens(expression.trim());
  const match = simpleComparisonPattern.exec(trimmed);
  if (!match) return null;
  const raw = match[3]!;
  const right = raw === "true"
    ? true
    : raw === "false"
      ? false
      : raw.startsWith("'") || raw.startsWith('"')
        ? raw.slice(1, -1)
        : Number(raw);
  return {
    left: match[1]!,
    operator: match[2] as SimpleComparisonOperator,
    right,
  };
}

/**
 * Serialize the guided-authoring subset back into the exact runtime grammar.
 * Returns `null` when a string cannot be represented without escaping because
 * the runtime grammar intentionally treats quoted values as raw text.
 */
export function formatSimpleComparisonExpression(expression: SimpleComparisonExpression): string | null {
  if (!safePathPattern.test(expression.left.trim())) return null;
  const value = expression.right;
  const right = typeof value === "boolean"
    ? String(value)
    : typeof value === "number"
      ? Number.isFinite(value) ? String(value) : null
    : !value.includes("'")
      ? `'${value}'`
      : !value.includes('"')
        ? `"${value}"`
        : null;
  if (right === null) return null;
  return `${expression.left.trim()} ${expression.operator} ${right}`;
}

/**
 * Evaluate the expression against `scope` (`{ context, inputs }`) and
 * coerce to boolean. Throws on grammar / evaluation errors so callers can
 * either surface to the user (validate path) or treat as falsy with logging.
 */
export function evaluateExpression(expression: string, scope: ExpressionScope) {
  return evaluateExpressionInternal(expression, scope, false);
}

function evaluateExpressionInternal(expression: string, scope: ExpressionScope, validateOnly: boolean) {
  const trimmed = stripOuterParens(expression.trim());

  if (!trimmed) {
    throw new Error("Expression cannot be empty");
  }

  return Boolean(evaluateBoolean(trimmed, scope, validateOnly));
}

function evaluateBoolean(expression: string, scope: ExpressionScope, validateOnly: boolean): unknown {
  const orParts = splitTopLevel(expression, "||");
  if (orParts.length > 1) {
    // Static validation must visit every branch: runtime short-circuiting would
    // otherwise hide an invalid contract behind `true || ...`.
    if (validateOnly) {
      return orParts.map((part) => Boolean(evaluateBoolean(part, scope, true))).some(Boolean);
    }
    return orParts.some((part) => Boolean(evaluateBoolean(part, scope, false)));
  }

  const andParts = splitTopLevel(expression, "&&");
  if (andParts.length > 1) {
    // Mirror the OR handling so `false && invalid` is still rejected by the
    // authoring validator while runtime evaluation keeps normal short-circuiting.
    if (validateOnly) {
      return andParts.map((part) => Boolean(evaluateBoolean(part, scope, true))).every(Boolean);
    }
    return andParts.every((part) => Boolean(evaluateBoolean(part, scope, false)));
  }

  const bare = expression.trim();
  const trimmed = stripOuterParens(bare);
  // Stripping a wrapping paren group can expose `||` / `&&` operators that the
  // top-level splits above skipped while they were nested (e.g. the
  // `(a || b)` part of `(a || b) && c`), so re-enter the boolean grammar
  // instead of falling through to the comparison stage.
  if (trimmed !== bare) return evaluateBoolean(trimmed, scope, validateOnly);
  if (trimmed.startsWith("!")) return !evaluateBoolean(trimmed.slice(1), scope, validateOnly);
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  for (const operator of comparisonOperators) {
    const parts = splitComparison(trimmed, operator);
    if (!parts) continue;

    const left = readValue(parts.left, scope);
    const right = readValue(parts.right, scope);

    switch (operator) {
      case "===":
        return left === right;
      case "!==":
        return left !== right;
      case "==":
        // oxlint-disable-next-line eqeqeq -- The workflow expression grammar intentionally exposes JavaScript loose equality.
        return left == right;
      case "!=":
        // oxlint-disable-next-line eqeqeq -- The workflow expression grammar intentionally exposes JavaScript loose inequality.
        return left != right;
      case ">":
        return compareOrdered(left, right, ">", validateOnly);
      case "<":
        return compareOrdered(left, right, "<", validateOnly);
      case ">=":
        return compareOrdered(left, right, ">=", validateOnly);
      case "<=":
        return compareOrdered(left, right, "<=", validateOnly);
      case "contains":
        return containsValue(left, right, validateOnly);
      case "startsWith":
        return startsWithValue(left, right, validateOnly);
      case "matches":
        return matchesValue(left, right, validateOnly);
      case "in":
        return isValueIn(left, right, validateOnly);
    }
  }

  return readValue(trimmed, scope);
}

function readValue(token: string, scope: ExpressionScope): unknown {
  const trimmed = stripOuterParens(token.trim());

  if (!trimmed) throw new Error("Expression value cannot be empty");
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return splitTopLevel(inner, ",").map(readPrimitiveArrayItem);
  }

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (safePathPattern.test(trimmed)) {
    return getBySafePath(scope, trimmed);
  }

  throw new Error(`Unsupported expression token: ${trimmed}`);
}

/** Parse one published primitive-array item; paths and nested arrays stay out. */
function readPrimitiveArrayItem(token: string): string | number | boolean | null {
  const trimmed = stripOuterParens(token.trim());
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  throw new Error(`Unsupported expression token: ${trimmed}`);
}

function compareOrdered(
  left: unknown,
  right: unknown,
  operator: ">" | "<" | ">=" | "<=",
  validateOnly: boolean,
): boolean {
  // Empty paths are expected while `validateExpression` checks syntax against
  // empty scopes. A known boolean/null/array partner still proves the contract
  // invalid; two unknown paths remain syntactically valid.
  if (left === undefined || right === undefined) {
    const known = left === undefined ? right : left;
    if (validateOnly && known !== undefined && typeof known !== "number" && typeof known !== "string") {
      throw new Error(`Ordered comparison ${operator} requires two numbers or two strings`);
    }
    return false;
  }

  let comparison: number;
  if (typeof left === "number" && typeof right === "number") {
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      if (validateOnly) throw new Error(`Ordered comparison ${operator} requires finite numbers`);
      return false;
    }
    comparison = left - right;
  } else if (typeof left === "string" && typeof right === "string") {
    // JavaScript's relational string comparison is deterministic UTF-16
    // lexicographic order, which also makes equal-width ISO timestamps useful.
    comparison = left === right ? 0 : left < right ? -1 : 1;
  } else {
    // Preserve the historical mixed numeric-string behavior while refusing
    // booleans, objects, null, and non-numeric strings instead of silently
    // comparing `NaN`.
    const leftNumber = typeof left === "number" || typeof left === "string" ? Number(left) : Number.NaN;
    const rightNumber = typeof right === "number" || typeof right === "string" ? Number(right) : Number.NaN;
    if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
      if (validateOnly) throw new Error(`Ordered comparison ${operator} requires two numbers or two strings`);
      return false;
    }
    comparison = leftNumber - rightNumber;
  }

  switch (operator) {
    case ">": return comparison > 0;
    case "<": return comparison < 0;
    case ">=": return comparison >= 0;
    case "<=": return comparison <= 0;
  }
}

function containsValue(left: unknown, right: unknown, validateOnly: boolean): boolean {
  if (left === undefined || right === undefined) return false;
  if (typeof left === "string" && typeof right === "string") return left.includes(right);
  if (Array.isArray(left)) return left.includes(right);
  if (validateOnly) throw new Error("contains requires a string or array on the left");
  return false;
}

function startsWithValue(left: unknown, right: unknown, validateOnly: boolean): boolean {
  if (left === undefined || right === undefined) {
    const known = left === undefined ? right : left;
    if (validateOnly && known !== undefined && typeof known !== "string") {
      throw new Error("startsWith requires two strings");
    }
    return false;
  }
  if (typeof left === "string" && typeof right === "string") return left.startsWith(right);
  if (validateOnly) throw new Error("startsWith requires two strings");
  return false;
}

function matchesValue(left: unknown, right: unknown, validateOnly: boolean): boolean {
  if (validateOnly) {
    if (typeof left === "string" && left.length > MAX_GLOB_VALUE_CHARS) {
      throw new Error(`matches value exceeds ${MAX_GLOB_VALUE_CHARS} characters`);
    }
    if (typeof right === "string" && right.length > MAX_GLOB_PATTERN_CHARS) {
      throw new Error(`matches pattern exceeds ${MAX_GLOB_PATTERN_CHARS} characters`);
    }
  }
  if (left === undefined || right === undefined) {
    const known = left === undefined ? right : left;
    if (validateOnly && known !== undefined && typeof known !== "string") {
      throw new Error("matches requires a string value and a glob pattern");
    }
    return false;
  }
  if (typeof left !== "string" || typeof right !== "string") {
    if (validateOnly) throw new Error("matches requires a string value and a glob pattern");
    return false;
  }
  return matchesGlob(left, right);
}

function isValueIn(left: unknown, right: unknown, validateOnly: boolean): boolean {
  // The right operand owns the operator contract, so validate it even when the
  // left path is unresolved in the empty static-validation scope.
  if (right === undefined) return false;
  if (!Array.isArray(right)) {
    if (validateOnly) throw new Error("in requires an array on the right");
    return false;
  }
  if (left === undefined) return false;
  return right.includes(left);
}

/** Bounded whole-string glob matcher (`*` any run, `?` one character). */
function matchesGlob(value: string, pattern: string): boolean {
  if (pattern.length > MAX_GLOB_PATTERN_CHARS) {
    throw new Error(`matches pattern exceeds ${MAX_GLOB_PATTERN_CHARS} characters`);
  }
  if (value.length > MAX_GLOB_VALUE_CHARS) {
    throw new Error(`matches value exceeds ${MAX_GLOB_VALUE_CHARS} characters`);
  }

  let valueIndex = 0;
  let patternIndex = 0;
  let starIndex = -1;
  let starValueIndex = 0;

  while (valueIndex < value.length) {
    const patternChar = pattern[patternIndex];
    if (patternChar === "?" || patternChar === value[valueIndex]) {
      patternIndex++;
      valueIndex++;
      continue;
    }
    if (patternChar === "*") {
      starIndex = patternIndex++;
      starValueIndex = valueIndex;
      continue;
    }
    if (starIndex >= 0) {
      patternIndex = starIndex + 1;
      valueIndex = ++starValueIndex;
      continue;
    }
    return false;
  }

  while (pattern[patternIndex] === "*") patternIndex++;
  return patternIndex === pattern.length;
}

function splitComparison(expression: string, operator: ComparisonOperator) {
  const parts = wordComparisonOperators.has(operator)
    ? splitWordComparison(expression, operator)
    : splitTopLevel(expression, operator);
  if (parts.length !== 2) return null;
  return { left: parts[0] ?? "", right: parts[1] ?? "" };
}

function splitWordComparison(expression: string, operator: ComparisonOperator): string[] {
  const parts: string[] = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    if ((char === '"' || char === "'") && !isEscaped(expression, i)) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }
    if (quote) continue;
    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;

    const before = expression[i - 1];
    const after = expression[i + operator.length];
    if (
      parenDepth === 0
      && bracketDepth === 0
      && expression.slice(i, i + operator.length) === operator
      && before !== undefined
      && after !== undefined
      && /\s/.test(before)
      && /\s/.test(after)
    ) {
      parts.push(expression.slice(start, i).trim());
      start = i + operator.length;
      i += operator.length - 1;
    }
  }

  if (!parts.length) return [expression.trim()];
  parts.push(expression.slice(start).trim());
  return parts;
}

function splitTopLevel(expression: string, operator: string) {
  const parts: string[] = [];
  let parenDepth = 0;
  let bracketDepth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];

    if ((char === '"' || char === "'") && !isEscaped(expression, i)) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }

    if (quote) continue;
    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth--;
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth--;

    if (parenDepth === 0 && bracketDepth === 0 && expression.slice(i, i + operator.length) === operator) {
      parts.push(expression.slice(start, i).trim());
      start = i + operator.length;
      i += operator.length - 1;
    }
  }

  if (!parts.length) return [expression.trim()];
  parts.push(expression.slice(start).trim());
  return parts;
}

function isEscaped(value: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor--) backslashes++;
  return backslashes % 2 === 1;
}

function stripOuterParens(expression: string) {
  let current = expression;

  while (current.startsWith("(") && current.endsWith(")") && wrapsWholeExpression(current)) {
    current = current.slice(1, -1).trim();
  }

  return current;
}

function wrapsWholeExpression(expression: string) {
  let depth = 0;
  let quote: string | null = null;

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];

    if ((char === '"' || char === "'") && !isEscaped(expression, i)) {
      quote = quote === char ? null : quote ?? char;
      continue;
    }

    if (quote) continue;
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth === 0 && i < expression.length - 1) return false;
  }

  return depth === 0;
}

function isReadableStreamLike(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (typeof (globalThis as { ReadableStream?: unknown }).ReadableStream !== "undefined"
    && value instanceof (globalThis as { ReadableStream: { new (): unknown } }).ReadableStream) {
    return true;
  }
  const v = value as { getReader?: unknown; tee?: unknown };
  return typeof v.getReader === "function" && typeof v.tee === "function";
}

function getBySafePath(scope: ExpressionScope, path: string) {
  const normalized = path.replace(/\[(\d+)\]/g, ".$1");

  const resolved = normalized.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, scope);

  if (isReadableStreamLike(resolved)) {
    throw new Error(`Refusing to evaluate a ReadableStream value at path ${path}; streams must be consumed within their executor.`);
  }

  return resolved;
}
