import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));

describe("MCP stdio server", () => {
  it("initializes and lists the published tools over stdio", async () => {
    const transport = new StdioClientTransport({
      command: "pnpm",
      args: ["start"],
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

      const result = await client.listTools();
      const names = result.tools.map((tool) => tool.name).sort();
      expect(names).toEqual([
        "ai.generate_workflow",
        "ai.patch_workflow",
        "dlq.clusters",
        "dlq.list",
        "mcp.connections.list",
        "mcp.connections.tools",
        "recipes.list",
        "recovery.metrics",
        "reports.run_explain",
        "runs.get",
        "runs.list",
        "tools.list",
        "workflows.get",
        "workflows.health",
        "workflows.list",
        "workflows.readiness",
        "workflows.validate",
        "workflows.versions",
      ]);
    } finally {
      await client.close();
    }
  }, 15_000);
});
