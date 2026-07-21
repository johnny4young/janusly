/** Route behavior for durable replay campaigns. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  list: vi.fn(),
  listDeadLetters: vi.fn(),
  enqueue: vi.fn(),
}));

vi.mock("@janusly/data", () => ({
  cancelReplayCampaign: mocks.cancel,
  createReplayCampaign: mocks.create,
  getReplayCampaign: mocks.get,
  listReplayCampaignDeadLetters: mocks.listDeadLetters,
  listReplayCampaigns: mocks.list,
  REPLAY_CAMPAIGN_MAX_ITEMS: 100,
  REPLAY_CAMPAIGN_MAX_PACING_MS: 60_000,
  REPLAY_CAMPAIGN_MIN_PACING_MS: 1_000,
  REPLAY_CAMPAIGN_NAME_MAX_CHARS: 120,
}));
vi.mock("@janusly/engine/src/queue", () => ({ enqueueReplayCampaignStep: mocks.enqueue }));
vi.mock("../audit-helper", () => ({ auditAction: vi.fn() }));
vi.mock("../mcp-consent", () => ({ guardMcpWrite: vi.fn(async () => ({ ok: true })) }));
vi.mock("../http", async importOriginal => {
  const actual = await importOriginal<typeof import("../http")>();
  return {
    ...actual,
    readJson: vi.fn(),
    sendError: vi.fn((_res: unknown, code: string, error: string, status = 400, params?: unknown) => ({
      payload: { error, code, params },
      status,
    })),
    sendJson: vi.fn((_res: unknown, payload: unknown, status = 200) => ({ payload, status })),
  };
});

import { auditAction } from "../audit-helper";
import { readJson } from "../http";
import type { Route } from "../routes";
import { replayCampaignsRoutes } from "./replay-campaigns-routes";

const auth = { orgId: "org-a", userId: "operator", mode: "dev-headers", source: "dev" } as const;
const now = new Date("2026-07-21T12:00:00.000Z");
const campaign = {
  id: "campaign-a",
  orgId: "org-a",
  name: "Retry invoices",
  clusterSignature: "sig-a",
  filterJson: { kind: "failure_cluster" },
  pacingMs: 2_000,
  status: "running",
  totalCount: 2,
  replayedCount: 0,
  failedCount: 0,
  cancelledCount: 0,
  createdBy: "operator",
  cancelledBy: null,
  nextDispatchAt: now,
  startedAt: now,
  completedAt: null,
  cancelledAt: null,
  createdAt: now,
  updatedAt: now,
};
const detail = { campaign, items: [] };

const deadLetters = ["dlq-a", "dlq-b"].map((id, index) => ({
  id,
  orgId: "org-a",
  runId: `run-${index}`,
  nodeId: "fetch",
  attempt: 1,
  workflowJson: { nodes: [], edges: [] },
  nodeJson: { id: "fetch", type: "http", config: { url: "https://example.com", method: "GET" } },
  errorJson: { message: "HTTP 503 Service Unavailable" },
  status: "open",
  replayClaimToken: null,
  replayClaimedAt: null,
  replayedAt: null,
  createdAt: now,
}));

function route(method: Route["method"], url: string): Route {
  const found = replayCampaignsRoutes.find(candidate => candidate.method === method && (
    typeof candidate.match === "string" ? candidate.match === url : candidate.match(url)
  ));
  if (!found) throw new Error(`route not found: ${method} ${url}`);
  return found;
}

async function call(method: Route["method"], url: string) {
  return route(method, url).handler({ req: { url } as never, res: {} as never, auth: auth as never });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listDeadLetters.mockResolvedValue(deadLetters);
  mocks.create.mockResolvedValue(detail);
  mocks.get.mockResolvedValue(detail);
  mocks.list.mockResolvedValue([campaign]);
  mocks.cancel.mockResolvedValue({
    campaign: { ...campaign, status: "cancelled", cancelledCount: 2 },
    items: [],
  });
  mocks.enqueue.mockResolvedValue(undefined);
});

describe("replay campaign route declarations", () => {
  it("uses DLQ read/replay permissions consistently", () => {
    expect(route("GET", "/recovery/campaigns")).toMatchObject({ role: "viewer", permission: "dlq.read" });
    expect(route("GET", "/recovery/campaigns/campaign-a")).toMatchObject({ role: "viewer", permission: "dlq.read" });
    expect(route("POST", "/recovery/campaigns")).toMatchObject({ role: "editor", permission: "dlq.replay" });
    expect(route("POST", "/recovery/campaigns/campaign-a/cancel")).toMatchObject({ role: "editor", permission: "dlq.replay" });
  });
});

describe("replay campaign lifecycle", () => {
  it("previews one matching open cluster without trusting a client signature", async () => {
    vi.mocked(readJson).mockResolvedValue({ deadLetterIds: ["dlq-a", "dlq-b"] });

    const result = await call("POST", "/recovery/campaigns/preview");

    expect(mocks.listDeadLetters).toHaveBeenCalledWith("org-a", ["dlq-a", "dlq-b"]);
    expect(result).toMatchObject({
      status: 200,
      payload: { canCreate: true, eligible: [{ deadLetterId: "dlq-a" }, { deadLetterId: "dlq-b" }], rejected: [] },
    });
  });

  it("rejects a mixed-signature cohort before persistence", async () => {
    vi.mocked(readJson).mockResolvedValue({
      name: "Mixed",
      pacingMs: 2_000,
      deadLetterIds: ["dlq-a", "dlq-b"],
    });
    mocks.listDeadLetters.mockResolvedValue([
      deadLetters[0],
      { ...deadLetters[1], errorJson: { message: "Missing secret: STRIPE_KEY" } },
    ]);

    const result = await call("POST", "/recovery/campaigns");

    expect(result).toMatchObject({ status: 409, payload: { code: "replay_campaign_invalid_cohort" } });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates, publishes, and audits a durable campaign", async () => {
    vi.mocked(readJson).mockResolvedValue({
      name: "Retry invoices",
      pacingMs: 2_000,
      deadLetterIds: ["dlq-a", "dlq-b"],
    });

    const result = await call("POST", "/recovery/campaigns");

    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-a",
      createdBy: "operator",
      pacingMs: 2_000,
      deadLetterIds: ["dlq-a", "dlq-b"],
      clusterSignature: expect.any(String),
    }));
    expect(mocks.enqueue).toHaveBeenCalledWith("campaign-a", now);
    expect(vi.mocked(auditAction)).toHaveBeenCalledWith(auth, "recovery.campaign.created", expect.any(Object));
    expect(result).toMatchObject({ status: 202, payload: { publicationDeferred: false } });
  });

  it("keeps an accepted campaign durable when initial Redis publication fails", async () => {
    vi.mocked(readJson).mockResolvedValue({
      name: "Retry invoices",
      pacingMs: 2_000,
      deadLetterIds: ["dlq-a", "dlq-b"],
    });
    mocks.enqueue.mockRejectedValue(new Error("redis down"));

    const result = await call("POST", "/recovery/campaigns");

    expect(result).toMatchObject({ status: 202, payload: { publicationDeferred: true } });
  });

  it("cancels only an organization-scoped running campaign", async () => {
    const result = await call("POST", "/recovery/campaigns/campaign-a/cancel");

    expect(mocks.cancel).toHaveBeenCalledWith("org-a", "campaign-a", "operator");
    expect(vi.mocked(auditAction)).toHaveBeenCalledWith(auth, "recovery.campaign.cancelled", expect.any(Object));
    expect(result).toMatchObject({ status: 200, payload: { campaign: { status: "cancelled" } } });
  });
});
