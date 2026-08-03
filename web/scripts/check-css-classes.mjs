/**
 * Reject CSS classes that have no production source owner.
 *
 * Janusly's hand-written stylesheet is intentionally dependency-free. This
 * ratchet parses selectors conservatively, reads string/template literals from
 * production TypeScript through the Oxc AST, and understands dynamic
 * class prefixes such as `we-status--${tone}`. Third-party React Flow selectors
 * are the only external class namespace.
 *
 * Used by: `pnpm lint` and `scripts/check-css-classes.test.mjs`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync, visitorKeys } from "oxc-parser";

const OPERATOR_KINDS = {
  "&&": "&&",
  "||": "||",
  "??": "??",
  "+": "+",
  "=": "=",
};

function normalizeAst(node, parent = null) {
  if (!node || typeof node !== "object") return;
  node.parent = parent;
  if (node.type === "Identifier" || node.type === "JSXIdentifier") node.text = node.name;
  if (node.type === "Literal") node.text = String(node.value ?? "");
  if (node.type === "VariableDeclarator") {
    node.name = node.id;
    node.initializer = node.init;
  } else if (["FunctionDeclaration", "FunctionExpression"].includes(node.type)) {
    node.name = node.id;
    node.parameters = node.params.map((parameter) => ({
      name: parameter.type === "AssignmentPattern" ? parameter.left : parameter,
      initializer: parameter.type === "AssignmentPattern" ? parameter.right : null,
    }));
  } else if (node.type === "ArrowFunctionExpression") {
    node.parameters = node.params.map((parameter) => ({
      name: parameter.type === "AssignmentPattern" ? parameter.left : parameter,
      initializer: parameter.type === "AssignmentPattern" ? parameter.right : null,
    }));
  } else if (node.type === "AssignmentPattern") {
    node.name = node.left;
    node.initializer = node.right;
  } else if (node.type === "CatchClause" && node.param) {
    node.variableDeclaration = { name: node.param };
  } else if (node.type === "Property") {
    node.name = node.key;
    node.initializer = node.value;
  } else if (node.type === "SpreadElement") {
    node.expression = node.argument;
  } else if (node.type === "ConditionalExpression") {
    node.whenTrue = node.consequent;
    node.whenFalse = node.alternate;
  } else if (node.type === "ReturnStatement") {
    node.expression = node.argument;
  } else if (node.type === "MemberExpression") {
    node.expression = node.object;
    node.name = node.property;
    node.argumentExpression = node.computed ? node.property : null;
  } else if (node.type === "CallExpression") {
    node.expression = node.callee;
  } else if (node.type === "JSXAttribute") {
    node.initializer = node.value;
  } else if (["BinaryExpression", "LogicalExpression", "AssignmentExpression"].includes(node.type)) {
    node.operatorToken = { kind: OPERATOR_KINDS[node.operator] ?? node.operator };
  } else if (node.type === "TemplateLiteral") {
    node.text = node.quasis[0]?.value.raw ?? "";
    node.head = { text: node.text };
    node.templateSpans = node.expressions.map((expression, index) => ({
      expression,
      literal: {
        text: node.quasis[index + 1]?.value.raw ?? "",
        tail: index === node.expressions.length - 1,
      },
    }));
  }
  for (const key of visitorKeys[node.type] ?? []) {
    const child = node[key];
    if (Array.isArray(child)) child.forEach((item) => normalizeAst(item, node));
    else normalizeAst(child, node);
  }
}

function createSourceFile(fileName, source) {
  const parsed = parseSync(fileName, source);
  if (parsed.errors.length > 0) {
    throw new Error(`Unable to inspect ${fileName}: ${parsed.errors[0].message}`);
  }
  normalizeAst(parsed.program);
  return parsed.program;
}

const ts = {
  ScriptTarget: { Latest: null },
  ScriptKind: { TS: null, TSX: null },
  SyntaxKind: {
    AmpersandAmpersandToken: "&&",
    BarBarToken: "||",
    QuestionQuestionToken: "??",
    PlusToken: "+",
    EqualsToken: "=",
  },
  createSourceFile,
  forEachChild(node, callback) {
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach((item) => item && callback(item));
      else if (child) callback(child);
    }
  },
  isArrayLiteralExpression: (node) => node.type === "ArrayExpression",
  isArrowFunction: (node) => node.type === "ArrowFunctionExpression",
  isAsExpression: (node) => node.type === "TSAsExpression",
  isBinaryExpression: (node) => ["AssignmentExpression", "BinaryExpression", "LogicalExpression"].includes(node.type),
  isBlock: (node) => node.type === "BlockStatement",
  isCallExpression: (node) => node.type === "CallExpression",
  isCaseBlock: (node) => node.type === "SwitchCase",
  isCatchClause: (node) => node.type === "CatchClause",
  isConditionalExpression: (node) => node.type === "ConditionalExpression",
  isElementAccessExpression: (node) => node.type === "MemberExpression" && node.computed,
  isFunctionDeclaration: (node) => node.type === "FunctionDeclaration",
  isFunctionExpression: (node) => node.type === "FunctionExpression",
  isFunctionLike: (node) => ["ArrowFunctionExpression", "FunctionDeclaration", "FunctionExpression"].includes(node.type),
  isIdentifier: (node) => node.type === "Identifier",
  isJsxAttribute: (node) => node.type === "JSXAttribute",
  isJsxExpression: (node) => node.type === "JSXExpressionContainer",
  isNonNullExpression: (node) => node.type === "TSNonNullExpression",
  isNoSubstitutionTemplateLiteral: (node) => node.type === "TemplateLiteral" && node.expressions.length === 0,
  isNumericLiteral: (node) => node.type === "Literal" && typeof node.value === "number",
  isObjectLiteralExpression: (node) => node.type === "ObjectExpression",
  isOmittedExpression: (node) => !node,
  isParenthesizedExpression: (node) => node.type === "ParenthesizedExpression",
  isPropertyAccessExpression: (node) => node.type === "MemberExpression" && !node.computed,
  isPropertyAssignment: (node) => node.type === "Property" && !node.shorthand,
  isReturnStatement: (node) => node.type === "ReturnStatement",
  isShorthandPropertyAssignment: (node) => node.type === "Property" && node.shorthand,
  isSourceFile: (node) => node.type === "Program",
  isSpreadAssignment: (node) => node.type === "SpreadElement",
  isSpreadElement: (node) => node.type === "SpreadElement",
  isStringLiteral: (node) => node.type === "Literal" && typeof node.value === "string",
  isTemplateExpression: (node) => node.type === "TemplateLiteral" && node.expressions.length > 0,
  isTemplateTail: (node) => node.tail,
  isTypeAssertionExpression: (node) => node.type === "TSTypeAssertion",
  isVariableDeclaration: (node) => node.type === "VariableDeclarator",
};

const CSS_CLASS_PATTERN = /\.(-?[_a-zA-Z]+[_a-zA-Z0-9-]*)/g;
const CLASS_TOKEN_PATTERN = /-?[_a-zA-Z]+[_a-zA-Z0-9-]*/g;
const EXTERNAL_CLASS_PREFIXES = ["react-flow__"];

function findCssBlockEnd(source, openingBrace) {
  let depth = 1;
  let quote = null;
  for (let index = openingBrace + 1; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "/" && next === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd === -1 ? source.length : commentEnd + 1;
    } else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  return source.length;
}

function findCssPreludeEnd(source, start, end) {
  let quote = null;
  let groupingDepth = 0;
  for (let index = start; index < end; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === "/" && next === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      index = commentEnd === -1 ? end : commentEnd + 1;
    } else if (character === "(" || character === "[") groupingDepth += 1;
    else if (character === ")" || character === "]") groupingDepth = Math.max(0, groupingDepth - 1);
    else if (groupingDepth === 0 && (character === "{" || character === ";")) {
      return { index, character };
    }
  }
  return null;
}

const NESTED_RULE_AT_RULES = new Set(["container", "document", "layer", "media", "scope", "starting-style", "supports"]);

/** Return every class declared in selector preludes, never declarations. */
export function extractCssClassSelectors(source) {
  const selectors = new Set();

  function scanRules(start, end) {
    let cursor = start;
    while (cursor < end) {
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      if (source[cursor] === "/" && source[cursor + 1] === "*") {
        const commentEnd = source.indexOf("*/", cursor + 2);
        cursor = commentEnd === -1 ? end : commentEnd + 2;
        continue;
      }
      const boundary = findCssPreludeEnd(source, cursor, end);
      if (!boundary) break;
      if (boundary.character === ";") {
        cursor = boundary.index + 1;
        continue;
      }

      const prelude = source.slice(cursor, boundary.index).trim();
      const blockEnd = findCssBlockEnd(source, boundary.index);
      if (prelude.startsWith("@")) {
        const atRule = prelude.match(/^@([\w-]+)/)?.[1];
        if (atRule && NESTED_RULE_AT_RULES.has(atRule)) scanRules(boundary.index + 1, blockEnd);
      } else {
        for (const match of prelude.matchAll(CSS_CLASS_PATTERN)) selectors.add(match[1]);
      }
      cursor = blockEnd + 1;
    }
  }

  scanRules(0, source.length);
  return selectors;
}

function addLiteralReferences(text, references) {
  for (const match of text.matchAll(CLASS_TOKEN_PATTERN)) references.classes.add(match[0]);
}

function addDynamicPrefix(text, references) {
  const match = text.match(/(-?[_a-zA-Z]+[_a-zA-Z0-9-]*-)$/);
  if (match) references.prefixes.add(match[1]);
}

/**
 * Return exact class tokens and dynamic prefixes from TypeScript literals.
 * Comments and identifiers are deliberately ignored so documentation cannot
 * keep dead CSS alive.
 */
export function extractTypeScriptClassReferences(source, fileName = "source.tsx") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const references = { classes: new Set(), prefixes: new Set() };
  const declarationsByScope = new Map();

  function addDeclaration(scope, name, initializer, declaration) {
    let declarations = declarationsByScope.get(scope);
    if (!declarations) {
      declarations = new Map();
      declarationsByScope.set(scope, declarations);
    }
    const bindings = declarations.get(name) ?? [];
    bindings.push({ declaration, initializer });
    declarations.set(name, bindings);
  }

  function addBindingName(scope, name, initializer, declaration) {
    if (!name || ts.isOmittedExpression(name)) return;
    if (name?.type === "ArrayPattern") {
      for (const element of name.elements) addBindingName(scope, element, null, declaration);
      return;
    }
    if (name?.type === "ObjectPattern") {
      for (const property of name.properties) {
        addBindingName(
          scope,
          property.type === "RestElement" ? property.argument : property.value,
          null,
          declaration,
        );
      }
      return;
    }
    if (name?.type === "RestElement") {
      addBindingName(scope, name.argument, null, declaration);
      return;
    }
    if (name?.type === "AssignmentPattern") {
      addBindingName(scope, name.left, name.right, declaration);
      return;
    }
    if (ts.isIdentifier(name)) {
      addDeclaration(scope, name.text, initializer, declaration);
    }
  }

  function nearestLexicalScope(node) {
    let current = node.parent;
    while (current) {
      if (ts.isBlock(current) || ts.isSourceFile(current) || ts.isCaseBlock(current)) return current;
      current = current.parent;
    }
    return sourceFile;
  }

  function indexDeclarations(node) {
    if (ts.isVariableDeclaration(node)) {
      addBindingName(nearestLexicalScope(node), node.name, node.initializer ?? null, node);
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      addDeclaration(nearestLexicalScope(node), node.name.text, node, node);
    }
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        addBindingName(node, parameter.name, parameter.initializer ?? null, parameter);
      }
    } else if (ts.isCatchClause(node) && node.variableDeclaration) {
      addBindingName(node, node.variableDeclaration.name, null, node.variableDeclaration);
    }
    ts.forEachChild(node, indexDeclarations);
  }

  function resolveIdentifier(node) {
    let current = node.parent;
    while (current) {
      const bindings = declarationsByScope.get(current)?.get(node.text);
      if (bindings) return bindings;
      current = current.parent;
    }
    return [];
  }

  function propertyNameText(name) {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
    return null;
  }

  function mergeAlternativePresence(states) {
    if (states.length === 0 || states.every((state) => state === "never")) return "never";
    if (states.every((state) => state === "always")) return "always";
    return "maybe";
  }

  function collectSelectedProperty(node, selectedName, resolving) {
    if (!node) return "never";
    if (ts.isIdentifier(node)) {
      const states = [];
      for (const binding of resolveIdentifier(node)) {
        if (!binding.initializer || resolving.has(binding.declaration)) continue;
        states.push(collectSelectedProperty(
          binding.initializer,
          selectedName,
          new Set(resolving).add(binding.declaration),
        ));
      }
      return mergeAlternativePresence(states);
    }
    if (ts.isObjectLiteralExpression(node)) {
      let laterSpreadMaybeDefines = false;
      for (const property of [...node.properties].reverse()) {
        if (ts.isPropertyAssignment(property) && propertyNameText(property.name) === selectedName) {
          collectClassExpression(property.initializer, resolving);
          return "always";
        } else if (ts.isShorthandPropertyAssignment(property) && property.name.text === selectedName) {
          collectClassExpression(property.name, resolving);
          return "always";
        } else if (ts.isSpreadAssignment(property)) {
          const spreadPresence = collectSelectedProperty(property.expression, selectedName, resolving);
          if (spreadPresence === "always") return "always";
          if (spreadPresence === "maybe") laterSpreadMaybeDefines = true;
        }
      }
      return laterSpreadMaybeDefines ? "maybe" : "never";
    }
    if (ts.isConditionalExpression(node)) {
      return mergeAlternativePresence([
        collectSelectedProperty(node.whenTrue, selectedName, resolving),
        collectSelectedProperty(node.whenFalse, selectedName, resolving),
      ]);
    }
    if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) {
      return collectSelectedProperty(node.expression, selectedName, resolving);
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      if (!node.body) return "never";
      if (ts.isBlock(node.body)) {
        const states = [];
        function collectReturns(child) {
          if (ts.isReturnStatement(child)) {
            states.push(collectSelectedProperty(child.expression, selectedName, resolving));
          }
          else if (!ts.isFunctionLike(child)) ts.forEachChild(child, collectReturns);
        }
        collectReturns(node.body);
        return mergeAlternativePresence(states);
      } else {
        return collectSelectedProperty(node.body, selectedName, resolving);
      }
    }
    return "never";
  }

  function collectClassExpression(node, resolving = new Set()) {
    if (!node) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      addLiteralReferences(node.text, references);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      addLiteralReferences(node.head.text, references);
      addDynamicPrefix(node.head.text, references);
      for (const span of node.templateSpans) {
        collectClassExpression(span.expression, resolving);
        addLiteralReferences(span.literal.text, references);
        if (!ts.isTemplateTail(span.literal)) addDynamicPrefix(span.literal.text, references);
      }
      return;
    }
    if (ts.isIdentifier(node)) {
      for (const binding of resolveIdentifier(node)) {
        if (!binding.initializer || resolving.has(binding.declaration)) continue;
        collectClassExpression(
          binding.initializer,
          new Set(resolving).add(binding.declaration),
        );
      }
      return;
    }
    if (ts.isConditionalExpression(node)) {
      collectClassExpression(node.whenTrue, resolving);
      collectClassExpression(node.whenFalse, resolving);
      return;
    }
    if (ts.isBinaryExpression(node)) {
      if (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
        collectClassExpression(node.right, resolving);
      } else if (
        node.operatorToken.kind === ts.SyntaxKind.BarBarToken
        || node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || node.operatorToken.kind === ts.SyntaxKind.PlusToken
      ) {
        collectClassExpression(node.left, resolving);
        collectClassExpression(node.right, resolving);
      }
      return;
    }
    if (
      ts.isParenthesizedExpression(node)
      || ts.isAsExpression(node)
      || ts.isTypeAssertionExpression(node)
      || ts.isNonNullExpression(node)
    ) {
      collectClassExpression(node.expression, resolving);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        collectClassExpression(ts.isSpreadElement(element) ? element.expression : element, resolving);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (ts.isPropertyAssignment(property)) collectClassExpression(property.initializer, resolving);
        else if (ts.isShorthandPropertyAssignment(property)) collectClassExpression(property.name, resolving);
        else if (ts.isSpreadAssignment(property)) collectClassExpression(property.expression, resolving);
      }
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      collectSelectedProperty(node.expression, node.name.text, resolving);
      return;
    }
    if (ts.isElementAccessExpression(node)) {
      const selectedName = node.argumentExpression && (
        ts.isStringLiteral(node.argumentExpression) || ts.isNumericLiteral(node.argumentExpression)
      )
        ? node.argumentExpression.text
        : null;
      if (selectedName === null) collectClassExpression(node.expression, resolving);
      else collectSelectedProperty(node.expression, selectedName, resolving);
      return;
    }
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      if (!node.body) return;
      if (ts.isBlock(node.body)) {
        function collectReturns(child) {
          if (ts.isReturnStatement(child)) collectClassExpression(child.expression, resolving);
          else ts.forEachChild(child, collectReturns);
        }
        collectReturns(node.body);
      } else {
        collectClassExpression(node.body, resolving);
      }
      return;
    }
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression)) {
        collectClassExpression(node.expression.expression, resolving);
      } else if (ts.isIdentifier(node.expression)) {
        collectClassExpression(node.expression, resolving);
      }
    }
  }

  function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.text === "className" && node.initializer) {
      if (ts.isStringLiteral(node.initializer)) addLiteralReferences(node.initializer.text, references);
      else if (ts.isJsxExpression(node.initializer)) collectClassExpression(node.initializer.expression);
    } else if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.name.text === "classList"
      && ["add", "remove", "replace", "toggle"].includes(node.expression.name.text)
    ) {
      for (const argument of node.arguments) collectClassExpression(argument);
    } else if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && node.left.name.text === "className"
    ) {
      collectClassExpression(node.right);
    }
    ts.forEachChild(node, visit);
  }

  indexDeclarations(sourceFile);
  visit(sourceFile);
  return references;
}

function mergeReferences(target, source) {
  for (const className of source.classes) target.classes.add(className);
  for (const prefix of source.prefixes) target.prefixes.add(prefix);
}

function listFiles(root, predicate) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(absolute, predicate));
    else if (entry.isFile() && predicate(entry.name)) files.push(absolute);
  }
  return files;
}

function isProductionTypeScriptFile(name) {
  return /\.tsx?$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts");
}

export function findOrphanCssClasses({ cssSources, typeScriptSources, externalPrefixes = EXTERNAL_CLASS_PREFIXES }) {
  const selectors = new Set();
  for (const source of cssSources) {
    for (const className of extractCssClassSelectors(source)) selectors.add(className);
  }

  const references = { classes: new Set(), prefixes: new Set() };
  for (const { source, fileName } of typeScriptSources) {
    mergeReferences(references, extractTypeScriptClassReferences(source, fileName));
  }

  return Array.from(selectors)
    .filter((className) => !references.classes.has(className))
    .filter((className) => !Array.from(references.prefixes).some((prefix) => className.startsWith(prefix)))
    .filter((className) => !externalPrefixes.some((prefix) => className.startsWith(prefix)))
    .sort();
}

export function checkCssClasses(sourceRoot) {
  const cssFiles = listFiles(sourceRoot, (name) => name.endsWith(".css"));
  const typeScriptFiles = listFiles(sourceRoot, isProductionTypeScriptFile);
  return findOrphanCssClasses({
    cssSources: cssFiles.map((file) => fs.readFileSync(file, "utf8")),
    typeScriptSources: typeScriptFiles.map((file) => ({
      fileName: file,
      source: fs.readFileSync(file, "utf8"),
    })),
  });
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const sourceRoot = path.join(repositoryRoot, "src");
  const orphans = checkCssClasses(sourceRoot);

  if (orphans.length > 0) {
    console.error(`Found ${orphans.length} CSS class selector(s) without a production owner:`);
    for (const className of orphans) console.error(`  .${className}`);
    process.exitCode = 1;
  } else {
    console.log("CSS class ratchet passed (0 unowned selectors).");
  }
}
