import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { V1_MCP_PATHS, V1_READ_PATHS, V1_WRITE_PATHS } from "@janusly/shared/src/api-contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { V1_CONTRACT_ROUTES } from "./api-contracts";
import { buildOpenApiDocument, serializeOpenApi } from "./openapi";

const checkedInPath = fileURLToPath(new URL("../openapi.v1.json", import.meta.url));

describe("OpenAPI v1 contract", () => {
  it("publishes every contracted operation with stable envelopes", () => {
    const document = buildOpenApiDocument(V1_CONTRACT_ROUTES) as {
      openapi: string;
      servers: Array<{ url: string }>;
      paths: Record<string, Record<string, {
        operationId: string;
        parameters?: Array<Record<string, unknown>>;
        responses: Record<string, unknown>;
      }>>;
    };

    expect(document.openapi).toBe("3.1.0");
    expect(document.servers).toEqual([{ url: "/v1", description: "Version 1" }]);
    expect(Object.keys(document.paths)).toEqual([...new Set([
      ...Object.values(V1_READ_PATHS),
      ...Object.values(V1_WRITE_PATHS),
      ...Object.values(V1_MCP_PATHS),
    ])].sort((a, b) => a.localeCompare(b)));
    expect(document.paths["/run"].get.operationId).toBe("getRun");
    expect(document.paths["/reports/run-explain"].get.operationId).toBe("getRunExplainReport");
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
    expect(document.paths["/runs/redrive"].post.operationId).toBe("redriveRun");
    expect(document.paths["/resume"].post.operationId).toBe("resumeRun");
    expect(document.paths["/run/cancel"].post.operationId).toBe("cancelRun");
    expect(document.paths["/workflows/{workflowId}/resume"].post.operationId)
      .toBe("resumeWorkflow");
    expect(document.paths["/mcp/connections/{alias}"].delete.operationId)
      .toBe("deleteMcpConnection");
    expect(document.paths["/mcp/connections/{alias}/tools/{toolName}"].post)
      .toMatchObject({
        operationId: "setMcpConnectionTool",
        parameters: [
          { name: "alias", in: "path", required: true },
          { name: "toolName", in: "path", required: true },
        ],
      });
  });

  it("matches the checked-in generated artifact byte-for-byte", () => {
    expect(readFileSync(checkedInPath, "utf8")).toBe(serializeOpenApi(V1_CONTRACT_ROUTES));
  });

  it("declares invalid_input for every dispatcher-validated request contract", () => {
    const missing = V1_CONTRACT_ROUTES
      .filter((route) => route.contract.request !== undefined)
      .filter((route) => !route.contract.errorCodes.includes("invalid_input"))
      .map((route) => route.contract.operationId);

    expect(missing).toEqual([]);
  });

  it("rejects drift between path templates and declared path schemas", () => {
    expect(() => buildOpenApiDocument([{
      method: "GET",
      contract: {
        operationId: "getDriftedPath",
        path: "/connections/{alias}",
        summary: "Drifted path",
        tags: ["Test"],
        request: { path: z.object({ connectionId: z.string() }).strict() },
        response: z.object({ ok: z.boolean() }),
        errorCodes: [],
      },
    }])).toThrow(/path parameters do not match/);
  });
});
