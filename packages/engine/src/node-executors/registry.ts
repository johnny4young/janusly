/** Stable, exhaustive composition of concrete workflow-node executors. */

import { loadRootEnv } from "@janusly/db";

import { agentNodeExecutors } from "./agents";
import { aiNodeExecutors } from "./ai";
import { delegatedNodeExecutors } from "./delegated";
import { mcpNodeExecutors } from "./mcp";
import { transportNodeExecutors } from "./transport";
import type {
  NodeContext,
  NodeExecutionResult,
  NodeExecutorMap,
  RegisteredNodeType,
} from "./types";
import { waitingNodeExecutors } from "./waiting";

loadRootEnv();

export const nodeRegistry: NodeExecutorMap = {
  ...transportNodeExecutors,
  ...agentNodeExecutors,
  ...aiNodeExecutors,
  ...waitingNodeExecutors,
  ...mcpNodeExecutors,
  ...delegatedNodeExecutors,
};

/** Dispatch one already-parsed config through its matching executor. */
export function executeRegisteredNode<T extends RegisteredNodeType>(
  type: T,
  ctx: NodeContext<T>,
): Promise<NodeExecutionResult> {
  return nodeRegistry[type](ctx);
}

export function isRegisteredNodeType(type: string): type is RegisteredNodeType {
  return Object.hasOwn(nodeRegistry, type);
}
