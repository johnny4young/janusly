import type {
  ExecuteNodeInput,
  NodeExecutionResult,
  NodeExecutorRegistry,
} from "../core/types";

export type ScriptedNodeExecutor = (
  input: ExecuteNodeInput,
) => NodeExecutionResult | Promise<NodeExecutionResult>;

/** Node executor registry with per-node and per-type handlers for runtime integration tests. */
export class ScriptedNodeExecutorRegistry implements NodeExecutorRegistry {
  private readonly nodeHandlers = new Map<string, ScriptedNodeExecutor>();
  private readonly typeHandlers = new Map<string, ScriptedNodeExecutor>();
  private readonly executionLog: ExecuteNodeInput[] = [];

  constructor(
    private readonly defaultHandler: ScriptedNodeExecutor = async () => ({
      status: "succeeded",
      output: {},
    }),
  ) {}

  onNode(nodeId: string, handler: ScriptedNodeExecutor): this {
    this.nodeHandlers.set(nodeId, handler);
    return this;
  }

  onType(nodeType: string, handler: ScriptedNodeExecutor): this {
    this.typeHandlers.set(nodeType, handler);
    return this;
  }

  listExecutions(): ExecuteNodeInput[] {
    return this.executionLog.map((input) => structuredClone(input));
  }

  async execute(input: ExecuteNodeInput): Promise<NodeExecutionResult> {
    this.executionLog.push(structuredClone(input));
    const handler = this.nodeHandlers.get(input.node.id)
      ?? this.typeHandlers.get(input.node.type)
      ?? this.defaultHandler;
    return handler(input);
  }
}
