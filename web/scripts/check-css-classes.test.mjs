import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkCssClasses,
  extractCssClassSelectors,
  extractTypeScriptClassReferences,
  findOrphanCssClasses,
} from "./check-css-classes.mjs";

test("extracts selector classes without reading comments or declaration strings", () => {
  const selectors = extractCssClassSelectors(`
    /* .comment-only */
    .we-card, .we-card[data-tone="warning"] {
      content: ".declaration-string";
      background-image: url("asset.icon.svg");
      opacity: 0.5;
    }
    .react-flow__node.selected { outline: 1px solid; }
  `);

  assert.deepEqual(Array.from(selectors).sort(), ["react-flow__node", "selected", "we-card"]);
});

test("reads exact classes and dynamic prefixes from TypeScript literals only", () => {
  const references = extractTypeScriptClassReferences(`
    // .comment-only must not count
    const state = "non-visual-state";
    const exact = ["we-card", "we-pill"];
    const dynamic = \`we-status we-status--\${tone}\`;
    const view = <div data-state={state} className={[...exact, dynamic].join(" ")} />;
  `, "component.tsx");

  assert.equal(references.classes.has("we-card"), true);
  assert.equal(references.classes.has("we-pill"), true);
  assert.equal(references.classes.has("comment-only"), false);
  assert.equal(references.classes.has("non-visual-state"), false);
  assert.equal(references.prefixes.has("we-status--"), true);
});

test("ignores omitted array bindings while indexing class references", () => {
  const references = extractTypeScriptClassReferences(`
    const [, unused] = ["ignored-card", "non-visual-state"];
    const view = <div className="owned-card" data-state={unused} />;
  `, "component.tsx");

  assert.deepEqual(Array.from(references.classes), ["owned-card"]);
});

test("unrelated production literals do not own CSS selectors", () => {
  const orphans = findOrphanCssClasses({
    cssSources: [".owned-card {} .dead-card {}"],
    typeScriptSources: [{
      fileName: "component.tsx",
      source: 'const endpoint = "/dead-card"; const view = <div className="owned-card" />;',
    }],
  });

  assert.deepEqual(orphans, ["dead-card"]);
});

test("resolves class bindings in their lexical scope", () => {
  const orphans = findOrphanCssClasses({
    cssSources: [".owned-card {} .dead-card {}"],
    typeScriptSources: [{
      fileName: "component.tsx",
      source: `
        function unrelated() {
          const classes = "/dead-card";
          return classes;
        }
        function Card() {
          const classes = "owned-card";
          return <div className={classes} />;
        }
      `,
    }],
  });

  assert.deepEqual(orphans, ["dead-card"]);
});

test("uses a shadowing parameter default as its class owner", () => {
  const orphans = findOrphanCssClasses({
    cssSources: [".owned-card {} .dead-card {}"],
    typeScriptSources: [{
      fileName: "component.tsx",
      source: `
        const classes = "/dead-card";
        function Card(classes = "owned-card") {
          return <div className={classes} />;
        }
      `,
    }],
  });

  assert.deepEqual(orphans, ["dead-card"]);
});

test("reads only the selected static class-map property", () => {
  const orphans = findOrphanCssClasses({
    cssSources: [".owned-card {} .dead-card {}"],
    typeScriptSources: [{
      fileName: "component.tsx",
      source: `
        const config = { className: "owned-card", endpoint: "/dead-card" };
        const view = <div className={config.className} />;
      `,
    }],
  });

  assert.deepEqual(orphans, ["dead-card"]);
});

test("reads shorthand and spread entries from a dynamic class map", () => {
  const orphans = findOrphanCssClasses({
    cssSources: [".primary-card {} .danger-card {}"],
    typeScriptSources: [{
      fileName: "component.tsx",
      source: `
        const primary = "primary-card";
        const extra = { danger: "danger-card" };
        const tones = { primary, ...extra };
        const view = <div className={tones[tone]} />;
      `,
    }],
  });

  assert.deepEqual(orphans, []);
});

test("honors static spread override order", () => {
  const afterSpread = findOrphanCssClasses({
    cssSources: [".owned-card {} .dead-card {}"],
    typeScriptSources: [{
      fileName: "component.tsx",
      source: `
        const base = { className: "dead-card" };
        const config = { ...base, className: "owned-card" };
        const view = <div className={config.className} />;
      `,
    }],
  });
  const afterExplicit = findOrphanCssClasses({
    cssSources: [".owned-card {} .dead-card {}"],
    typeScriptSources: [{
      fileName: "component.tsx",
      source: `
        const base = { className: "dead-card" };
        const config = { className: "owned-card", ...base };
        const view = <div className={config.className} />;
      `,
    }],
  });

  assert.deepEqual(afterSpread, ["dead-card"]);
  assert.deepEqual(afterExplicit, ["owned-card"]);
});

test("keeps fallback classes reachable through a conditional spread", () => {
  const orphans = findOrphanCssClasses({
    cssSources: [".fallback-card {} .override-card {}"],
    typeScriptSources: [{
      fileName: "component.tsx",
      source: `
        const config = {
          className: "fallback-card",
          ...(enabled ? { className: "override-card" } : {}),
        };
        const view = <div className={config.className} />;
      `,
    }],
  });

  assert.deepEqual(orphans, []);
});

test("reports only selectors without exact, dynamic, or external ownership", () => {
  const orphans = findOrphanCssClasses({
    cssSources: [
      ".we-card {} .we-status--ok {} .react-flow__node {} .legacy-card {}",
    ],
    typeScriptSources: [{
      fileName: "component.tsx",
      source: 'const card = "we-card"; const status = `we-status--${tone}`; const view = <div className={`${card} ${status}`} />;',
    }],
  });

  assert.deepEqual(orphans, ["legacy-card"]);
});

test("does not let test-only references keep a selector alive", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "janusly-css-ratchet-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "styles.css"), ".runtime-card {}\n");
  fs.writeFileSync(path.join(root, "component.test.tsx"), 'const selector = "runtime-card";\n');

  assert.deepEqual(checkCssClasses(root), ["runtime-card"]);
});

test("the repository source tree has no unowned class selectors", () => {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  assert.deepEqual(checkCssClasses(path.join(repositoryRoot, "src")), []);
});
