export function evaluateExpression(expression: string, scope: Record<string, any>) {
  const trimmed = expression.trim();

  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // MVP implementation.
  // TODO: replace with a safer expression language such as JSONLogic or CEL.
  const fn = new Function("scope", `
    const context = scope.context;
    const inputs = scope.inputs;
    return (${trimmed});
  `);

  return Boolean(fn(scope));
}
