import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@janusly/data/src/promptsRepo", () => ({
  createPrompt: vi.fn(),
  createPromptVersion: vi.fn(),
  getPromptByName: vi.fn(),
  getPromptVersion: vi.fn(),
  listPromptVersions: vi.fn(),
  listPrompts: vi.fn(),
  pinPromptVersion: vi.fn(),
}));

vi.mock("../audit", () => ({
  audit: vi.fn(),
}));

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  const sendJson = vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status }));
  return {
    ...actual,
    readJson: vi.fn(),
    sendJson,
    sendError: vi.fn((_res: unknown, code: string, message: string, status = 400, params?: Record<string, unknown>) =>
      sendJson(_res, params === undefined ? { error: message, code } : { error: message, code, params }, status)),
  };
});

import {
  createPrompt,
  createPromptVersion,
  getPromptByName,
  pinPromptVersion,
} from "@janusly/data/src/promptsRepo";

import { audit } from "../audit";
import { readJson, sendJson } from "../http";
import type { Route } from "../routes";
import { promptsRoutes } from "./prompts-routes";

const promptRow = {
  id: "prompt-1",
  orgId: "org-1",
  name: "incident_summary",
  description: "Summarise incidents",
  pinnedVersionId: null,
  createdBy: "user-1",
  createdAt: new Date("2026-05-20T00:00:00.000Z"),
  updatedAt: new Date("2026-05-20T00:00:00.000Z"),
};

const versionRow = {
  id: "version-1",
  orgId: "org-1",
  promptId: "prompt-1",
  version: 1,
  templateText: "Summarise {{var.incidentId}}",
  variables: [{ name: "incidentId", type: "string", required: true }],
  status: "published",
  createdBy: "user-1",
  createdAt: new Date("2026-05-20T00:01:00.000Z"),
};

const auth = {
  orgId: "org-1",
  userId: "user-1",
  mode: "dev-headers",
  source: "dev",
} as const;

function findRoute(method: Route["method"], url: string): Route {
  const route = promptsRoutes.find((candidate) => {
    if (candidate.method !== method) return false;
    return typeof candidate.match === "string"
      ? candidate.match === url
      : candidate.match(url);
  });
  if (!route) throw new Error(`route not found: ${method} ${url}`);
  return route;
}

async function callRoute(route: Route, url: string) {
  return route.handler({
    req: { url } as never,
    res: {} as never,
    auth: auth as never,
  });
}

beforeEach(() => {
  vi.mocked(createPrompt).mockReset();
  vi.mocked(createPromptVersion).mockReset();
  vi.mocked(getPromptByName).mockReset();
  vi.mocked(pinPromptVersion).mockReset();
  vi.mocked(audit).mockReset();
  vi.mocked(readJson).mockReset();
  vi.mocked(sendJson).mockClear();
  vi.mocked(audit).mockResolvedValue(undefined);
});

describe("promptsRoutes route permissions", () => {
  it("uses PromptOps permissions on read and write routes", () => {
    expect(findRoute("GET", "/prompts").permission).toBe("prompts.read");
    expect(findRoute("POST", "/prompts").permission).toBe("prompts.write");
    expect(findRoute("GET", "/prompts/incident_summary").permission).toBe("prompts.read");
    expect(findRoute("GET", "/prompts/incident_summary/versions/1").permission).toBe("prompts.read");
    expect(findRoute("POST", "/prompts/incident_summary/versions").permission).toBe("prompts.write");
    expect(findRoute("POST", "/prompts/incident_summary/versions/1/pin").permission).toBe("prompts.write");
  });
});

describe("POST /prompts", () => {
  it("creates an org-scoped prompt and audits prompt.created", async () => {
    vi.mocked(readJson).mockResolvedValueOnce({
      name: "incident_summary",
      description: "Summarise incidents",
    });
    vi.mocked(getPromptByName).mockResolvedValueOnce(null);
    vi.mocked(createPrompt).mockResolvedValueOnce(promptRow as never);

    await callRoute(findRoute("POST", "/prompts"), "/prompts");

    expect(createPrompt).toHaveBeenCalledWith({
      orgId: "org-1",
      name: "incident_summary",
      description: "Summarise incidents",
      createdBy: "user-1",
    });
    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "prompt.created",
      "prompt",
      "prompt-1",
      expect.objectContaining({ name: "incident_summary" }),
    );
    expect(sendJson).toHaveBeenLastCalledWith(expect.anything(), { prompt: promptRow }, 201);
  });

  it("returns 409 for duplicate prompt names before insert or audit", async () => {
    vi.mocked(readJson).mockResolvedValueOnce({ name: "incident_summary" });
    vi.mocked(getPromptByName).mockResolvedValueOnce(promptRow as never);

    await callRoute(findRoute("POST", "/prompts"), "/prompts");

    expect(createPrompt).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
    expect(sendJson).toHaveBeenLastCalledWith(
      expect.anything(),
      { error: "a prompt with this name already exists", code: "prompts_name_duplicate" },
      409,
    );
  });
});

describe("POST /prompts/:name/versions", () => {
  it("appends a version using the route org and audits prompt.version_created", async () => {
    vi.mocked(readJson).mockResolvedValueOnce({
      templateText: "Summarise {{var.incidentId}}",
      variables: [{ name: "incidentId", type: "string", required: true }],
    });
    vi.mocked(getPromptByName).mockResolvedValueOnce(promptRow as never);
    vi.mocked(createPromptVersion).mockResolvedValueOnce(versionRow as never);

    await callRoute(
      findRoute("POST", "/prompts/incident_summary/versions"),
      "/prompts/incident_summary/versions",
    );

    expect(createPromptVersion).toHaveBeenCalledWith({
      orgId: "org-1",
      promptId: "prompt-1",
      templateText: "Summarise {{var.incidentId}}",
      variables: [{ name: "incidentId", type: "string", required: true }],
      createdBy: "user-1",
    });
    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "prompt.version_created",
      "prompt_version",
      "version-1",
      expect.objectContaining({ name: "incident_summary", version: 1, promptId: "prompt-1" }),
    );
    expect(sendJson).toHaveBeenLastCalledWith(expect.anything(), { version: versionRow }, 201);
  });
});

describe("POST /prompts/:name/versions/:version/pin", () => {
  it("pins the active version and audits prompt.version_pinned", async () => {
    const updatedPrompt = { ...promptRow, pinnedVersionId: "version-1" };
    vi.mocked(getPromptByName).mockResolvedValueOnce(promptRow as never);
    vi.mocked(pinPromptVersion).mockResolvedValueOnce({
      prompt: updatedPrompt,
      previousVersionId: null,
    } as never);

    await callRoute(
      findRoute("POST", "/prompts/incident_summary/versions/1/pin"),
      "/prompts/incident_summary/versions/1/pin",
    );

    expect(pinPromptVersion).toHaveBeenCalledWith({
      orgId: "org-1",
      promptId: "prompt-1",
      version: 1,
    });
    expect(audit).toHaveBeenCalledWith(
      "org-1",
      "user-1",
      "prompt.version_pinned",
      "prompt",
      "prompt-1",
      expect.objectContaining({
        name: "incident_summary",
        version: 1,
        from: null,
        to: "version-1",
      }),
    );
    expect(sendJson).toHaveBeenLastCalledWith(expect.anything(), { prompt: updatedPrompt });
  });
});
