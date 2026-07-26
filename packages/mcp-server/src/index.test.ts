import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

describe("MCP stdio server", () => {
  it("initializes and lists the published tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: packageDir,
      stderr: "pipe",
    });
    const client = new Client(
      { name: "janusly-mcp-smoke", version: "0.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      expect(client.getServerCapabilities()?.tools).toBeDefined();
      expect(client.getServerVersion()).toMatchObject({
        name: "janusly",
        version: "0.0.2",
      });
      expect(client.getInstructions()).toContain(
        "call workflows.validate and workflows.readiness",
      );

      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "ai.generate_workflow",
        "ai.patch_workflow",
        "dlq.clusters",
        "dlq.list",
        "mcp.connections.list",
        "mcp.connections.tools",
        "memory.consent_status",
        "recipes.list",
        "recovery.ledger",
        "recovery.metrics",
        "recovery.my_wins",
        "reports.run_explain",
        "runs.get",
        "runs.list",
        "runs.status",
        "runs.usage",
        "tools.list",
        "workflows.get",
        "workflows.health",
        "workflows.list",
        "workflows.readiness",
        "workflows.schedule_preview",
        "workflows.validate",
        "workflows.versions",
      ]);
      const sideEffecting = new Set([
        "ai.generate_workflow",
        "ai.patch_workflow",
        "reports.run_explain",
      ]);
      for (const tool of result.tools) {
        expect(tool.outputSchema).toBeDefined();
        expect(tool.annotations?.readOnlyHint).toBe(!sideEffecting.has(tool.name));
      }

      const invalid = await client.callTool({
        name: "workflows.get",
        arguments: {},
      });
      expect(invalid.isError).toBe(true);
      expect(invalid.structuredContent).toMatchObject({
        result: {
          ok: false,
          error: {
            code: "mcp_tool_error",
            message: expect.stringContaining("workflowId"),
          },
        },
      });
    } finally {
      await client.close();
    }
  }, 15_000);

  it("proxies a successful API call as structured content over the real MCP protocol", async () => {
    const requests: string[] = [];
    const api = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        apiVersion: "v1",
        requestId: "req-mcp-smoke",
        data: [{ id: "wf-1", createdAt: "2026-07-26T00:00:00.000Z" }],
      }));
    });
    await new Promise<void>((resolve, reject) => {
      api.once("error", reject);
      api.listen(0, "127.0.0.1", resolve);
    });
    const { port } = api.address() as AddressInfo;

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--import", "tsx", "src/index.ts"],
      cwd: packageDir,
      env: {
        ...process.env,
        JANUSLY_API_URL: `http://127.0.0.1:${port}`,
      } as Record<string, string>,
      stderr: "pipe",
    });
    const client = new Client(
      { name: "janusly-mcp-proxy-smoke", version: "0.0.0" },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      const result = await client.callTool({
        name: "workflows.list",
        arguments: {
          limit: 1,
          tag: ["operations", "critical"],
          before: "2026-07-26T00:00:00.000Z|wf-2",
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        result: [{ id: "wf-1", createdAt: "2026-07-26T00:00:00.000Z" }],
      });
      expect(requests).toEqual([
        "/v1/workflows?limit=1&tag=operations&tag=critical&before=2026-07-26T00%3A00%3A00.000Z%7Cwf-2",
      ]);
    } finally {
      await client.close();
      await new Promise<void>((resolve, reject) => {
        api.close((error) => error ? reject(error) : resolve());
      });
    }
  }, 15_000);
});
