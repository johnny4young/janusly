/**
 * Route-level tests for /credentials.
 *
 * Covers the new health endpoint declaration + the permission gates we
 * just back-filled. The dispatcher's role / permission gates are
 * declarative and run before the handler — these tests pin the route
 * entry's shape rather than re-running the dispatcher.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../http", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
    readJson: vi.fn(),
  };
});

vi.mock("@janusly/data/src/credentialHealthRepo", () => ({
  getCredentialHealth: vi.fn(),
}));

vi.mock("@janusly/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: vi.fn().mockResolvedValue([]) })),
    })),
    insert: vi.fn(() => ({ values: vi.fn().mockResolvedValue(undefined) })),
  },
  credentials: { id: "id", orgId: "org_id" },
}));

vi.mock("../audit", () => ({
  audit: vi.fn(),
}));

import { credentialsRoutes } from "./credentials-routes";
import { sendJson } from "../http";
import { getCredentialHealth } from "@janusly/data/src/credentialHealthRepo";
import type { Route } from "../routes";

const sendJsonMock = vi.mocked(sendJson);
const getCredentialHealthMock = vi.mocked(getCredentialHealth);

function findRoute(method: string, path: string): Route {
  const route = credentialsRoutes.find((r) => {
    if (r.method !== method) return false;
    return typeof r.match === "string" ? r.match === path : r.match(path);
  });
  if (!route) throw new Error(`route not found: ${method} ${path}`);
  return route;
}

async function callRoute(method: string, path: string, auth = { orgId: "org-1", userId: "user-1", mode: "dev-headers", source: "dev" }) {
  const route = findRoute(method, path);
  return route.handler({
    req: { url: path } as never,
    res: {} as never,
    auth: auth as never,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /credentials/health", () => {
  it("declares role: viewer + permission: credentials.read so the dispatcher gates non-readers", () => {
    const route = findRoute("GET", "/credentials/health");
    expect(route.role).toBe("viewer");
    expect(route.permission).toBe("credentials.read");
  });

  it("calls getCredentialHealth scoped to the caller's org and returns its snapshot", async () => {
    getCredentialHealthMock.mockResolvedValueOnce({
      credentials: [
        {
          id: "c1",
          name: "slack-prod",
          kind: "slack_webhook",
          secretRefPresent: true,
          lastUsedAt: null,
          lastErrorAt: null,
          lastErrorMessage: null,
          usageCount30d: 0,
          referencingWorkflowIds: [],
        },
      ],
      mcpConnections: [],
      generatedAt: new Date().toISOString(),
    });
    await callRoute("GET", "/credentials/health");
    expect(getCredentialHealthMock).toHaveBeenCalledTimes(1);
    expect(getCredentialHealthMock.mock.calls[0]?.[0]).toBe("org-1");
    // Second arg is the resolver function — must be present + callable.
    const resolver = getCredentialHealthMock.mock.calls[0]?.[1];
    expect(typeof resolver).toBe("function");
    const payload = sendJsonMock.mock.calls[0]?.[1] as { credentials: unknown[] };
    expect(payload.credentials).toHaveLength(1);
  });
});

describe("POST /credentials gate", () => {
  it("now declares BOTH role: admin AND permission: credentials.write (defense in depth)", () => {
    const route = findRoute("POST", "/credentials");
    expect(route.role).toBe("admin");
    expect(route.permission).toBe("credentials.write");
  });
});
