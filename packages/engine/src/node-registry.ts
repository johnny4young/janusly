/**
 * Stable compatibility surface for concrete workflow-node execution.
 *
 * Responsibility modules live under `node-executors/`. Runtime-owned router
 * nodes remain in `core/runtime.ts`; every other workflow-node type is composed
 * by the exhaustive registry without changing its public import path.
 */

export {
  executeRegisteredNode,
  isRegisteredNodeType,
  nodeRegistry,
} from "./node-executors/registry";
export {
  isWriteSideNode,
  ToolResultPolicyError,
} from "./node-executors/transport";
export type {
  NodeContext,
  NodeExecutionResult,
  NodeExecutor,
  NodeExecutorMap,
  RegisteredNodeType,
} from "./node-executors/types";
