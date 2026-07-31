import { describe, expect, expectTypeOf, it } from "vitest";
import {
  isRegisteredNodeType,
  nodeRegistry,
  type NodeContext,
  type NodeExecutor,
  type NodeExecutorMap,
} from "./node-registry";

type IsAny<T> = 0 extends 1 & T ? true : false;

describe("typed node executor registry", () => {
  it("binds executor configs to their node schemas", () => {
    const httpConfigIsAny: IsAny<NodeContext<"http">["config"]> = false;
    const mcpConfigIsAny: IsAny<NodeContext<"mcp_tool">["config"]> = false;

    expect(httpConfigIsAny).toBe(false);
    expect(mcpConfigIsAny).toBe(false);
    expectTypeOf<NodeContext<"http">["config"]>().toMatchTypeOf<{ url: string }>();
    expectTypeOf<NodeContext<"mcp_tool">["config"]>().toMatchTypeOf<{
      connectionAlias: string;
      toolName: string;
    }>();
    expectTypeOf(nodeRegistry.http).toEqualTypeOf<NodeExecutor<"http">>();
    expectTypeOf(nodeRegistry).toEqualTypeOf<NodeExecutorMap>();
  });

  it("keeps runtime-owned routers outside the concrete executor registry", () => {
    expect(isRegisteredNodeType("http")).toBe(true);
    expect(isRegisteredNodeType("mcp_tool")).toBe(true);
    expect(isRegisteredNodeType("router")).toBe(false);
    expect(isRegisteredNodeType("router_llm")).toBe(false);
    expect(isRegisteredNodeType("unknown")).toBe(false);
  });
});
