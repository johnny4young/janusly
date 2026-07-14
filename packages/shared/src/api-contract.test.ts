import { describe, expect, it } from "vitest";

import { isV1ReadPath, V1_READ_PATHS } from "./api-contract";

describe("v1 API read paths", () => {
  it("keeps the closed path catalog unique", () => {
    const paths = Object.values(V1_READ_PATHS);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toHaveLength(9);
  });

  it("matches exact paths only", () => {
    expect(isV1ReadPath("/workflows")).toBe(true);
    expect(isV1ReadPath("/workflows/versions")).toBe(true);
    expect(isV1ReadPath("/workflows/tags")).toBe(false);
    expect(isV1ReadPath("/runs/abc/stream")).toBe(false);
  });
});
