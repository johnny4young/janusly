import { describe, expect, it } from "vitest";

import {
  CACHE_INVALIDATION_CHANNEL,
  cacheInvalidationKinds,
  parseCacheInvalidationMessage,
} from "./cache-invalidation";

describe("cache invalidation protocol", () => {
  it("uses one stable, closed channel and message vocabulary", () => {
    expect(CACHE_INVALIDATION_CHANNEL).toBe("janusly:cache:invalidate");
    expect(cacheInvalidationKinds).toEqual(["recovery-metrics", "org-config"]);
  });

  it("parses valid tenant-scoped cache invalidations", () => {
    expect(parseCacheInvalidationMessage('{"kind":"org-config","orgId":"org-a"}')).toEqual({
      kind: "org-config",
      orgId: "org-a",
    });
  });

  it.each([
    "not json",
    "null",
    "[]",
    "{}",
    '{"kind":"unknown","orgId":"org-a"}',
    '{"kind":"org-config","orgId":""}',
    '{"kind":"org-config","orgId":42}',
  ])("rejects malformed or unsupported payloads: %s", (raw) => {
    expect(parseCacheInvalidationMessage(raw)).toBeNull();
  });
});
