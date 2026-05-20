import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the promptsRepo BEFORE importing the resolver so the resolver's
// internal `await getPromptByName(...)` etc. resolve to the mocks. Two
// orgs are pre-seeded so cross-org isolation tests have a foil.
type FakePrompt = { id: string; orgId: string; name: string; pinnedVersionId: string | null };
type FakeVersion = {
  id: string;
  orgId: string;
  promptId: string;
  version: number;
  templateText: string;
  variables: Array<{ name: string; type: string; required: boolean; defaultValue?: unknown }>;
};

let promptsByKey: Map<string, FakePrompt> = new Map();
let versionsByPrompt: Map<string, FakeVersion[]> = new Map();

function key(orgId: string, name: string) {
  return `${orgId}::${name}`;
}

function seedPrompt(orgId: string, name: string, opts: { pinnedVersionId?: string | null } = {}): FakePrompt {
  const p: FakePrompt = {
    id: `p-${orgId}-${name}`,
    orgId,
    name,
    pinnedVersionId: opts.pinnedVersionId ?? null,
  };
  promptsByKey.set(key(orgId, name), p);
  return p;
}

function seedVersion(p: FakePrompt, version: number, templateText: string, variables: FakeVersion["variables"] = []): FakeVersion {
  const v: FakeVersion = {
    id: `v-${p.id}-${version}`,
    orgId: p.orgId,
    promptId: p.id,
    version,
    templateText,
    variables,
  };
  const list = versionsByPrompt.get(p.id) ?? [];
  list.push(v);
  versionsByPrompt.set(p.id, list);
  return v;
}

vi.mock("@janusly/data/src/promptsRepo", () => ({
  getPromptByName: async (orgId: string, name: string) => promptsByKey.get(key(orgId, name)) ?? null,
  getPromptVersion: async (orgId: string, promptId: string, version: number) => {
    const list = versionsByPrompt.get(promptId) ?? [];
    return list.find((v) => v.orgId === orgId && v.version === version) ?? null;
  },
  getPromptVersionById: async (orgId: string, id: string) => {
    for (const list of versionsByPrompt.values()) {
      const found = list.find((v) => v.id === id && v.orgId === orgId);
      if (found) return found;
    }
    return null;
  },
  resolveActiveVersion: async (orgId: string, promptId: string) => {
    const prompt = [...promptsByKey.values()].find((p) => p.id === promptId && p.orgId === orgId);
    if (!prompt) return null;
    const list = versionsByPrompt.get(promptId) ?? [];
    if (list.length === 0) return null;
    if (prompt.pinnedVersionId) {
      const pinned = list.find((v) => v.id === prompt.pinnedVersionId);
      if (pinned) return { prompt, version: pinned };
    }
    const sorted = [...list].sort((a, b) => b.version - a.version);
    return { prompt, version: sorted[0] };
  },
}));

import {
  MAX_INCLUDE_DEPTH,
  MissingPromptError,
  MissingPromptVersionError,
  MissingVariableError,
  NoPromptVersionsError,
  PromptIncludeDepthExceededError,
  RecursivePromptIncludeError,
  resolvePromptRef,
  substituteVariables,
} from "./prompt-resolver";

beforeEach(() => {
  promptsByKey = new Map();
  versionsByPrompt = new Map();
});

describe("resolvePromptRef — basic resolution", () => {
  it("returns the active version's templateText when no version is requested", async () => {
    const p = seedPrompt("org-1", "welcome");
    seedVersion(p, 1, "Hello, world.");
    seedVersion(p, 2, "Welcome, friend.");
    const result = await resolvePromptRef({
      orgId: "org-1",
      ref: { name: "welcome" },
    });
    // No pin → latest version (version 2)
    expect(result.resolvedText).toBe("Welcome, friend.");
    expect(result.version).toBe(2);
    expect(result.promptName).toBe("welcome");
  });

  it("returns a specific version when requested", async () => {
    const p = seedPrompt("org-1", "welcome");
    seedVersion(p, 1, "Hello, world.");
    seedVersion(p, 2, "Welcome, friend.");
    const result = await resolvePromptRef({
      orgId: "org-1",
      ref: { name: "welcome", version: 1 },
    });
    expect(result.resolvedText).toBe("Hello, world.");
    expect(result.version).toBe(1);
  });

  it("uses the pinned version when set", async () => {
    const p = seedPrompt("org-1", "welcome");
    seedVersion(p, 1, "Hello, world.");
    const v2 = seedVersion(p, 2, "Welcome, friend.");
    seedVersion(p, 3, "Newest greeting.");
    p.pinnedVersionId = v2.id;
    const result = await resolvePromptRef({
      orgId: "org-1",
      ref: { name: "welcome" },
    });
    expect(result.resolvedText).toBe("Welcome, friend.");
    expect(result.version).toBe(2);
  });
});

describe("resolvePromptRef — error surfaces", () => {
  it("throws MissingPromptError when the prompt does not exist", async () => {
    await expect(
      resolvePromptRef({
        orgId: "org-1",
        ref: { name: "ghost" },
      }),
    ).rejects.toBeInstanceOf(MissingPromptError);
  });

  it("throws MissingPromptVersionError when a specific version is requested but absent", async () => {
    const p = seedPrompt("org-1", "welcome");
    seedVersion(p, 1, "Hello.");
    await expect(
      resolvePromptRef({
        orgId: "org-1",
        ref: { name: "welcome", version: 99 },
      }),
    ).rejects.toBeInstanceOf(MissingPromptVersionError);
  });

  it("throws NoPromptVersionsError when the prompt exists but has no versions", async () => {
    seedPrompt("org-1", "empty");
    await expect(
      resolvePromptRef({
        orgId: "org-1",
        ref: { name: "empty" },
      }),
    ).rejects.toBeInstanceOf(NoPromptVersionsError);
  });

  it("throws MissingVariableError BEFORE any LLM call when a required variable is missing", async () => {
    const p = seedPrompt("org-1", "greet");
    seedVersion(p, 1, "Hello {{var.userName}}!", [
      { name: "userName", type: "string", required: true },
    ]);
    await expect(
      resolvePromptRef({
        orgId: "org-1",
        ref: { name: "greet" },
        nodeContext: { variables: {} },
      }),
    ).rejects.toBeInstanceOf(MissingVariableError);
  });
});

describe("resolvePromptRef — variable substitution", () => {
  it("substitutes string / number / boolean values", async () => {
    const p = seedPrompt("org-1", "facts");
    seedVersion(
      p,
      1,
      "user={{var.name}} count={{var.count}} active={{var.active}}",
      [
        { name: "name", type: "string", required: true },
        { name: "count", type: "number", required: true },
        { name: "active", type: "boolean", required: true },
      ],
    );
    const result = await resolvePromptRef({
      orgId: "org-1",
      ref: { name: "facts" },
      nodeContext: { variables: { name: "Ada", count: 3, active: true } },
    });
    expect(result.resolvedText).toBe("user=Ada count=3 active=true");
  });

  it("falls back to defaultValue when an optional variable is missing", async () => {
    const p = seedPrompt("org-1", "greet");
    seedVersion(p, 1, "Hi {{var.userName}}", [
      { name: "userName", type: "string", required: false, defaultValue: "stranger" },
    ]);
    const result = await resolvePromptRef({
      orgId: "org-1",
      ref: { name: "greet" },
      nodeContext: { variables: {} },
    });
    expect(result.resolvedText).toBe("Hi stranger");
  });

  it("substitutes undeclared variables that are supplied at call time", async () => {
    const p = seedPrompt("org-1", "greet");
    // No declared variables — but the template still references one.
    seedVersion(p, 1, "Hi {{var.userName}}", []);
    const result = await resolvePromptRef({
      orgId: "org-1",
      ref: { name: "greet" },
      nodeContext: { variables: { userName: "Bob" } },
    });
    expect(result.resolvedText).toBe("Hi Bob");
  });
});

describe("resolvePromptRef — include flattening", () => {
  it("inlines an {{include.X}} reference", async () => {
    const helper = seedPrompt("org-1", "helper");
    seedVersion(helper, 1, "(helped)");
    const main = seedPrompt("org-1", "main");
    seedVersion(main, 1, "Before {{include.helper}} after.");
    const result = await resolvePromptRef({
      orgId: "org-1",
      ref: { name: "main" },
    });
    expect(result.resolvedText).toBe("Before (helped) after.");
  });

  it("resolves nested includes (A → B → C)", async () => {
    const c = seedPrompt("org-1", "c");
    seedVersion(c, 1, "[C]");
    const b = seedPrompt("org-1", "b");
    seedVersion(b, 1, "[B {{include.c}}]");
    const a = seedPrompt("org-1", "a");
    seedVersion(a, 1, "[A {{include.b}}]");
    const result = await resolvePromptRef({
      orgId: "org-1",
      ref: { name: "a" },
    });
    expect(result.resolvedText).toBe("[A [B [C]]]");
  });

  it("rejects a cycle with RecursivePromptIncludeError", async () => {
    const a = seedPrompt("org-1", "a");
    seedVersion(a, 1, "A → {{include.b}}");
    const b = seedPrompt("org-1", "b");
    seedVersion(b, 1, "B → {{include.a}}");
    await expect(
      resolvePromptRef({ orgId: "org-1", ref: { name: "a" } }),
    ).rejects.toBeInstanceOf(RecursivePromptIncludeError);
  });

  it("rejects a self-cycle (A → A)", async () => {
    const a = seedPrompt("org-1", "a");
    seedVersion(a, 1, "loop → {{include.a}}");
    await expect(
      resolvePromptRef({ orgId: "org-1", ref: { name: "a" } }),
    ).rejects.toBeInstanceOf(RecursivePromptIncludeError);
  });

  it("rejects an include chain that exceeds MAX_INCLUDE_DEPTH (defensive cap)", async () => {
    // Build a non-cyclic chain longer than the depth cap so the cap
    // engages before any cycle would.
    const namesInOrder: string[] = [];
    for (let i = 0; i < MAX_INCLUDE_DEPTH + 2; i++) {
      const name = `n${i}`;
      namesInOrder.push(name);
      const p = seedPrompt("org-1", name);
      const next = `n${i + 1}`;
      // The last one terminates without an include.
      const tmpl = i === MAX_INCLUDE_DEPTH + 1 ? "leaf" : `node → {{include.${next}}}`;
      seedVersion(p, 1, tmpl);
    }
    await expect(
      resolvePromptRef({ orgId: "org-1", ref: { name: "n0" } }),
    ).rejects.toBeInstanceOf(PromptIncludeDepthExceededError);
  });
});

describe("resolvePromptRef — multi-tenant isolation", () => {
  it("does NOT find a prompt that lives only in another org", async () => {
    seedPrompt("org-2", "secret");
    seedVersion({ id: "p-org-2-secret", orgId: "org-2", name: "secret", pinnedVersionId: null }, 1, "leak");
    await expect(
      resolvePromptRef({ orgId: "org-1", ref: { name: "secret" } }),
    ).rejects.toBeInstanceOf(MissingPromptError);
  });

  it("does NOT follow an {{include.X}} into another org", async () => {
    // org-1 has a prompt that tries to include `cross` (which only
    // lives in org-2). The resolver must NOT find it; missing prompt
    // is the right error, not a successful cross-org include.
    seedPrompt("org-2", "cross");
    seedVersion({ id: "p-org-2-cross", orgId: "org-2", name: "cross", pinnedVersionId: null }, 1, "leaked text");
    const main = seedPrompt("org-1", "main");
    seedVersion(main, 1, "before {{include.cross}} after");
    await expect(
      resolvePromptRef({ orgId: "org-1", ref: { name: "main" } }),
    ).rejects.toBeInstanceOf(MissingPromptError);
  });
});

describe("substituteVariables (helper) — direct unit tests", () => {
  it("returns the input unchanged when no tokens are present", () => {
    expect(substituteVariables("hello world", [], {}, "p1")).toBe("hello world");
  });

  it("substitutes a single declared variable", () => {
    const text = "hello {{var.name}}!";
    expect(
      substituteVariables(text, [{ name: "name", type: "string", required: true }], { name: "Ada" }, "p1"),
    ).toBe("hello Ada!");
  });

  it("throws when a required variable is missing", () => {
    expect(() =>
      substituteVariables("hi {{var.x}}", [{ name: "x", type: "string", required: true }], {}, "p1"),
    ).toThrow(MissingVariableError);
  });

  it("stringifies objects as JSON", () => {
    const out = substituteVariables(
      "data={{var.cfg}}",
      [],
      { cfg: { a: 1, b: [2, 3] } },
      "p1",
    );
    expect(out).toBe(`data={"a":1,"b":[2,3]}`);
  });
});
