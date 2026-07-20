import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { V1_READ_PATHS, V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";
import { describe, expect, it } from "vitest";

import { V1_CONTRACT_ROUTES } from "./api-contracts";
import { buildOpenApiDocument, serializeOpenApi } from "./openapi";

const checkedInPath = fileURLToPath(new URL("../openapi.v1.json", import.meta.url));

describe("OpenAPI v1 contract", () => {
  it("publishes every contracted operation with stable envelopes", () => {
    const document = buildOpenApiDocument(V1_CONTRACT_ROUTES) as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>;
    };

    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([{ url: "/v1", description: "Version 1" }]);
    expect(Object.keys(document.paths)).toEqual([
      ...Object.values(V1_READ_PATHS),
      ...Object.values(V1_WRITE_PATHS),
    ].sort());
    expect(document.paths["/run"].get.operationId).toBe("getRun");
    expect(document.paths["/run"].get.responses).toHaveProperty("200");
    expect(document.paths["/run"].get.responses).toHaveProperty("default");
    expect(document.paths["/run"].get.responses).toMatchObject({
      "200": { headers: { "X-Request-Id": expect.any(Object) } },
      default: { headers: { "X-Request-Id": expect.any(Object) } },
    });
    const runSuccess = document.paths["/run"].get.responses["200"] as {
      content: { "application/json": { schema: { properties: { data: Record<string, unknown> } } } };
    };
    expect(runSuccess.content["application/json"].schema.properties.data)
      .not.toHaveProperty("additionalProperties");
    expect(document.paths["/start"].post.operationId).toBe("startRun");
    expect(document.paths["/resume"].post.operationId).toBe("resumeRun");
    expect(document.paths["/run/cancel"].post.operationId).toBe("cancelRun");
  });

  it("matches the checked-in generated artifact byte-for-byte", () => {
    expect(readFileSync(checkedInPath, "utf8")).toBe(serializeOpenApi(V1_CONTRACT_ROUTES));
  });
});
