/**
 * Safe jq-style JSON selector subset for the `json.jq` tool.
 *
 * Supported grammar:
 * - `.` identity
 * - `.user.name` object property traversal
 * - `.items[0]` array index traversal
 * - `.items[]` array projection
 * - `.["dash-key"]` bracket property traversal
 * - `.items[] | .email` pipelines
 *
 * This intentionally does not evaluate arbitrary jq programs. It is a pure,
 * deterministic selector for workflow payloads.
 */

type JqToken =
  | { kind: "property"; key: string }
  | { kind: "index"; index: number }
  | { kind: "iterate" };

type JqStage = JqToken[];

export function evaluateJsonJq(source: unknown, query: string): unknown {
  const stages = parseJsonJqQuery(query);
  let stream: unknown[] = [source];

  for (const stage of stages) {
    const next: unknown[] = [];
    for (const value of stream) {
      next.push(...applyStage(value, stage));
    }
    stream = next;
  }

  if (stream.length === 0) return null;
  if (stream.length === 1) return stream[0];
  return stream;
}

export function parseJsonJqQuery(query: string): JqStage[] {
  const stages = splitPipeline(query).map((stage) => stage.trim());
  if (stages.length === 0 || stages.some((stage) => stage.length === 0)) {
    throw new Error("json.jq query must contain at least one selector stage");
  }
  return stages.map(parseStage);
}

function applyStage(value: unknown, stage: JqStage): unknown[] {
  let stream: unknown[] = [value];
  for (const token of stage) {
    const next: unknown[] = [];
    for (const item of stream) {
      next.push(...applyToken(item, token));
    }
    stream = next;
  }
  return stream;
}

function applyToken(value: unknown, token: JqToken): unknown[] {
  if (token.kind === "iterate") {
    return Array.isArray(value) ? value : [];
  }

  if (token.kind === "index") {
    if (!Array.isArray(value)) return [undefined];
    const index = token.index < 0 ? value.length + token.index : token.index;
    return [value[index]];
  }

  if (typeof value !== "object" || value === null) return [undefined];
  return [(value as Record<string, unknown>)[token.key]];
}

function parseStage(stage: string): JqStage {
  if (!stage.startsWith(".")) {
    throw new Error(`json.jq selector must start with ".": ${stage}`);
  }
  if (stage === ".") return [];

  const tokens: JqToken[] = [];
  let index = 1;

  while (index < stage.length) {
    const char = stage[index];

    if (char === ".") {
      index += 1;
      continue;
    }

    if (char === "[") {
      const parsed = parseBracket(stage, index);
      tokens.push(parsed.token);
      index = parsed.nextIndex;
      continue;
    }

    if (char === "\"") {
      const parsed = parseQuoted(stage, index);
      tokens.push({ kind: "property", key: parsed.value });
      index = parsed.nextIndex;
      continue;
    }

    const parsed = parseProperty(stage, index);
    tokens.push({ kind: "property", key: parsed.value });
    index = parsed.nextIndex;
  }

  return tokens;
}

function parseProperty(stage: string, start: number): { value: string; nextIndex: number } {
  let index = start;
  while (index < stage.length && stage[index] !== "." && stage[index] !== "[") {
    index += 1;
  }
  const value = stage.slice(start, index).trim();
  if (!value) {
    throw new Error(`json.jq selector has an empty property near: ${stage.slice(start)}`);
  }
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
    throw new Error(`json.jq bare properties must be identifiers; use bracket notation for: ${value}`);
  }
  return { value, nextIndex: index };
}

function parseBracket(stage: string, start: number): { token: JqToken; nextIndex: number } {
  let index = start + 1;
  if (stage[index] === "]") {
    return { token: { kind: "iterate" }, nextIndex: index + 1 };
  }

  if (stage[index] === "\"") {
    const parsed = parseQuoted(stage, index);
    index = parsed.nextIndex;
    if (stage[index] !== "]") {
      throw new Error(`json.jq bracket property must end with "]": ${stage}`);
    }
    return { token: { kind: "property", key: parsed.value }, nextIndex: index + 1 };
  }

  while (index < stage.length && stage[index] !== "]") {
    index += 1;
  }
  if (stage[index] !== "]") {
    throw new Error(`json.jq bracket selector must end with "]": ${stage}`);
  }

  const raw = stage.slice(start + 1, index).trim();
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`json.jq bracket selector supports only integer indexes or quoted keys: ${raw}`);
  }

  return { token: { kind: "index", index: Number(raw) }, nextIndex: index + 1 };
}

function parseQuoted(stage: string, start: number): { value: string; nextIndex: number } {
  let index = start + 1;
  let escaped = false;
  let literal = "\"";

  while (index < stage.length) {
    const char = stage[index];
    literal += char;

    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "\"") {
      try {
        return { value: JSON.parse(literal) as string, nextIndex: index + 1 };
      } catch {
        throw new Error(`json.jq has an invalid quoted property: ${literal}`);
      }
    }

    index += 1;
  }

  throw new Error(`json.jq quoted property is not closed: ${stage.slice(start)}`);
}

function splitPipeline(query: string): string[] {
  const stages: string[] = [];
  let current = "";
  let bracketDepth = 0;
  let inString = false;
  let escaped = false;

  for (const char of query) {
    if (inString) {
      current += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      current += char;
      continue;
    }

    if (char === "[") bracketDepth += 1;
    if (char === "]") {
      bracketDepth -= 1;
      if (bracketDepth < 0) {
        throw new Error("json.jq has a closing bracket without an opening bracket");
      }
    }

    if (char === "|" && bracketDepth === 0) {
      stages.push(current);
      current = "";
      continue;
    }

    current += char;
  }

  stages.push(current);
  if (inString) {
    throw new Error("json.jq quoted property is not closed");
  }
  if (bracketDepth !== 0) {
    throw new Error("json.jq bracket selector is not closed");
  }
  return stages;
}
