/**
 * Limited-grammar expression evaluator used by `condition` nodes and edge
 * `condition` strings. Recursive-descent parser over a tiny grammar:
 * boolean composition (`||`, `&&`, `!`, parens), comparisons (`===`, `!==`,
 * `==`, `!=`, `>`, `<`, `>=`, `<=`), boolean / number / string literals,
 * `null`, and dotted paths starting with `context.` or `inputs.`.
 *
 * Used by the engine (`condition` executor + edge guard), API workflow
 * sanitization, and the web Inspector's Expression Assistant. Keeping this
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

const comparisonOperators = ["===", "!==", ">=", "<=", "==", "!=", ">", "<"] as const;

/**
 * Static-evaluate the expression with empty scopes to surface syntactic /
 * grammar errors. Returns `{ valid: false, message }` on any throw.
 */
export function validateExpression(expression: string): ExpressionValidationResult {
  try {
    evaluateExpression(expression, { context: {}, inputs: {} });
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
 * Evaluate the expression against `scope` (`{ context, inputs }`) and
 * coerce to boolean. Throws on grammar / evaluation errors so callers can
 * either surface to the user (validate path) or treat as falsy with logging.
 */
export function evaluateExpression(expression: string, scope: ExpressionScope) {
  const trimmed = stripOuterParens(expression.trim());

  if (!trimmed) {
    throw new Error("Expression cannot be empty");
  }

  return Boolean(evaluateBoolean(trimmed, scope));
}

function evaluateBoolean(expression: string, scope: ExpressionScope): unknown {
  const orParts = splitTopLevel(expression, "||");
  if (orParts.length > 1) return orParts.some(part => Boolean(evaluateBoolean(part, scope)));

  const andParts = splitTopLevel(expression, "&&");
  if (andParts.length > 1) return andParts.every(part => Boolean(evaluateBoolean(part, scope)));

  const trimmed = stripOuterParens(expression.trim());
  if (trimmed.startsWith("!")) return !evaluateBoolean(trimmed.slice(1), scope);
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
        return left == right;
      case "!=":
        return left != right;
      case ">":
        return Number(left) > Number(right);
      case "<":
        return Number(left) < Number(right);
      case ">=":
        return Number(left) >= Number(right);
      case "<=":
        return Number(left) <= Number(right);
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

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);

  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  if (/^(context|inputs)(\.[A-Za-z0-9_$-]+|\[\d+\])*$/.test(trimmed)) {
    return getBySafePath(scope, trimmed);
  }

  throw new Error(`Unsupported expression token: ${trimmed}`);
}

function splitComparison(expression: string, operator: string) {
  const parts = splitTopLevel(expression, operator);
  if (parts.length !== 2) return null;
  return { left: parts[0] ?? "", right: parts[1] ?? "" };
}

function splitTopLevel(expression: string, operator: string) {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;

  for (let i = 0; i < expression.length; i++) {
    const char = expression[i];
    const previous = expression[i - 1];

    if ((char === '"' || char === "'") && previous !== "\\") {
      quote = quote === char ? null : quote ?? char;
      continue;
    }

    if (quote) continue;
    if (char === "(") depth++;
    if (char === ")") depth--;

    if (depth === 0 && expression.slice(i, i + operator.length) === operator) {
      parts.push(expression.slice(start, i).trim());
      start = i + operator.length;
      i += operator.length - 1;
    }
  }

  if (!parts.length) return [expression.trim()];
  parts.push(expression.slice(start).trim());
  return parts;
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
    const previous = expression[i - 1];

    if ((char === '"' || char === "'") && previous !== "\\") {
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
