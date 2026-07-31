import { createHash } from "node:crypto";
import { isOpenNodeStatus, isTerminalRunStatus } from "@janusly/shared/src/status";
import type {
  ExecutionStore,
  NodeCompletionOutcome,
  NodeStatus,
  QueuePublicationClaim,
  RunContext,
  RunMetadata,
  RunStatus,
  SemanticOutcomeViolationRecord,
  SerializedError,
  TerminalFailureInput,
  WorkflowEvent,
} from "../core/types";

export type InMemoryNodeSeed = {
  nodeId: string;
  status?: NodeStatus;
  attempts?: number;
  state?: Record<string, unknown>;
  output?: unknown;
  error?: SerializedError | null;
  recoveryClaimToken?: string | null;
  publicationGeneration?: number;
  publicationPending?: boolean;
};

export type InMemoryRunSeed = {
  runId: string;
  status?: RunStatus;
  metadata?: RunMetadata | null;
  nodes: readonly InMemoryNodeSeed[];
};

export type InMemoryNodeSnapshot = {
  nodeId: string;
  status: NodeStatus;
  attempts: number;
  state: Record<string, unknown>;
  output: unknown;
  error: SerializedError | null;
  recoveryClaimToken: string | null;
  publicationGeneration: number;
  publicationPending: boolean;
  publicationDelayMs: number;
};

export type InMemoryRunSnapshot = {
  runId: string;
  status: RunStatus;
  metadata: RunMetadata | null;
  nodes: InMemoryNodeSnapshot[];
};

export type InMemorySemanticCase = {
  id: string;
  runId: string;
  violation: SemanticOutcomeViolationRecord;
};

type MutableNodeRecord = Omit<InMemoryNodeSnapshot, "output">;

type MutableRunRecord = {
  runId: string;
  status: RunStatus;
  metadata: RunMetadata | null;
  nodes: Map<string, MutableNodeRecord>;
};

function cloneValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

function stableSemanticCaseId(runId: string, detectorId: string): string {
  return `sem_${createHash("sha256")
    .update(`${runId}\0${detectorId}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function tokenMatches(actual: string | null, expected?: string): boolean {
  return actual === (expected ?? null);
}

function nodeOutput(node: MutableNodeRecord): unknown {
  return Object.hasOwn(node.state, "output") ? node.state.output : {};
}

/** Stateful test implementation of the runtime persistence boundary. */
export class InMemoryExecutionStore implements ExecutionStore {
  private readonly runs = new Map<string, MutableRunRecord>();
  private readonly eventLog: WorkflowEvent[] = [];
  private readonly semanticCaseLog: InMemorySemanticCase[] = [];

  constructor(seed?: InMemoryRunSeed | readonly InMemoryRunSeed[]) {
    if (seed) {
      for (const run of Array.isArray(seed) ? seed : [seed]) this.seedRun(run);
    }
  }

  seedRun(seed: InMemoryRunSeed): void {
    if (this.runs.has(seed.runId)) {
      throw new Error(`Run ${seed.runId} is already seeded`);
    }
    const nodes = new Map<string, MutableNodeRecord>();
    for (const node of seed.nodes) {
      if (nodes.has(node.nodeId)) {
        throw new Error(`Node ${node.nodeId} is duplicated in run ${seed.runId}`);
      }
      const state = cloneValue(node.state ?? {});
      if (node.output !== undefined) state.output = cloneValue(node.output);
      nodes.set(node.nodeId, {
        nodeId: node.nodeId,
        status: node.status ?? "pending",
        attempts: node.attempts ?? 0,
        state,
        error: cloneValue(node.error ?? null),
        recoveryClaimToken: node.recoveryClaimToken ?? null,
        publicationGeneration: node.publicationGeneration ?? 0,
        publicationPending: node.publicationPending ?? false,
        publicationDelayMs: 0,
      });
    }
    this.runs.set(seed.runId, {
      runId: seed.runId,
      status: seed.status ?? "running",
      metadata: cloneValue(seed.metadata ?? null),
      nodes,
    });
  }

  getRunSnapshot(runId: string): InMemoryRunSnapshot | null {
    const run = this.runs.get(runId);
    if (!run) return null;
    return {
      runId,
      status: run.status,
      metadata: cloneValue(run.metadata),
      nodes: [...run.nodes.values()].map((node) => this.snapshotNode(node)),
    };
  }

  getNodeSnapshot(runId: string, nodeId: string): InMemoryNodeSnapshot | null {
    const node = this.runs.get(runId)?.nodes.get(nodeId);
    return node ? this.snapshotNode(node) : null;
  }

  listEvents(runId?: string): WorkflowEvent[] {
    return this.eventLog
      .filter((event) => !runId || event.runId === runId)
      .map((event) => cloneValue(event));
  }

  listSemanticCases(runId?: string): InMemorySemanticCase[] {
    return this.semanticCaseLog
      .filter((entry) => !runId || entry.runId === runId)
      .map((entry) => cloneValue(entry));
  }

  async getRunContext(runId: string, opts: { statusesOnly?: boolean } = {}): Promise<RunContext> {
    const run = this.runs.get(runId);
    if (!run) return {};
    return Object.fromEntries([...run.nodes.values()].map((node) => [
      node.nodeId,
      {
        status: node.status,
        attempts: node.attempts,
        state: opts.statusesOnly ? {} : cloneValue(node.state),
        output: opts.statusesOnly ? {} : cloneValue(nodeOutput(node)),
        error: opts.statusesOnly ? null : cloneValue(node.error),
      },
    ]));
  }

  async getRunStatus(runId: string): Promise<RunStatus | null> {
    return this.runs.get(runId)?.status ?? null;
  }

  async getRunMetadata(runId: string): Promise<RunMetadata | null> {
    return cloneValue(this.runs.get(runId)?.metadata ?? null);
  }

  async getNodeStatus(runId: string, nodeId: string): Promise<NodeStatus> {
    return this.requireNode(runId, nodeId).status;
  }

  async markNodeQueued(
    runId: string,
    nodeId: string,
    attempt = 1,
    recoveryClaimToken?: string,
    delayMs = 0,
  ): Promise<QueuePublicationClaim | null> {
    const run = this.requireRun(runId);
    const node = this.requireNode(runId, nodeId);
    if (
      run.status !== "running"
      || node.status !== "running"
      || !tokenMatches(node.recoveryClaimToken, recoveryClaimToken)
    ) {
      return null;
    }
    node.status = "queued";
    node.attempts = attempt;
    node.publicationGeneration += 1;
    node.publicationPending = true;
    node.publicationDelayMs = Math.max(0, Math.trunc(delayMs));
    return this.publicationClaim(node);
  }

  async tryClaimNodeForQueue(
    runId: string,
    nodeId: string,
    attempt = 1,
  ): Promise<QueuePublicationClaim | null> {
    const node = this.requireNode(runId, nodeId);
    if (node.status !== "pending") return null;
    node.status = "queued";
    node.attempts = node.publicationPending && node.attempts > 0
      ? node.attempts
      : attempt;
    node.publicationGeneration += 1;
    node.publicationPending = true;
    node.publicationDelayMs = 0;
    return this.publicationClaim(node);
  }

  async claimNodeForExecution(
    runId: string,
    nodeId: string,
    attempt = 1,
    recoveryClaimToken?: string,
    publicationGeneration = 0,
  ): Promise<"claimed" | "not_claimed" | "run_failed" | "run_cancelled" | "run_terminal"> {
    const run = this.runs.get(runId);
    if (!run) return "run_terminal";
    const node = run.nodes.get(nodeId);
    if (!node) return "not_claimed";
    const exactGeneration = node.status === "queued"
      && node.attempts === attempt
      && tokenMatches(node.recoveryClaimToken, recoveryClaimToken)
      && node.publicationGeneration === publicationGeneration;

    if (run.status !== "running") {
      if (run.status === "failed" && exactGeneration) {
        node.status = "pending";
        node.publicationPending = true;
      }
      const claim = run.status === "failed"
        ? "run_failed"
        : run.status === "cancelled"
          ? "run_cancelled"
          : "run_terminal";
      await this.appendEvent({
        runId,
        nodeId,
        type: "node.skipped",
        payload: {
          reason: `Run ${run.status}`,
          attempt,
          ...(run.status === "failed" && exactGeneration
            ? { restoredForRecovery: true }
            : {}),
        },
      });
      return claim;
    }

    if (!exactGeneration) return "not_claimed";
    node.status = "running";
    node.attempts = attempt;
    node.publicationPending = false;
    node.publicationDelayMs = 0;
    return "claimed";
  }

  async markQueuePublicationSucceeded(
    runId: string,
    nodeId: string,
    attempt: number,
    publicationGeneration: number,
    recoveryClaimToken?: string,
  ): Promise<boolean> {
    const node = this.requireNode(runId, nodeId);
    if (
      node.status !== "queued"
      || node.attempts !== attempt
      || node.publicationGeneration !== publicationGeneration
      || !tokenMatches(node.recoveryClaimToken, recoveryClaimToken)
    ) {
      return false;
    }
    node.publicationPending = false;
    return true;
  }

  async markNodeSucceeded(
    runId: string,
    nodeId: string,
    output: unknown,
    recoveryClaimToken?: string,
  ): Promise<boolean> {
    return this.completeNode(runId, nodeId, output, recoveryClaimToken);
  }

  async markNodeSucceededWithEvent(
    runId: string,
    nodeId: string,
    output: unknown,
    attempt: number,
    recoveryClaimToken?: string,
  ): Promise<boolean> {
    const completed = this.completeNode(runId, nodeId, output, recoveryClaimToken);
    if (!completed) return false;
    await this.appendEvent({
      runId,
      nodeId,
      type: "node.succeeded",
      payload: { output: cloneValue(output ?? {}), attempt },
    });
    return true;
  }

  async markNodeSucceededWithOutcome(
    runId: string,
    nodeId: string,
    output: unknown,
    attempt: number,
    violations: readonly SemanticOutcomeViolationRecord[],
    recoveryClaimToken?: string,
  ): Promise<NodeCompletionOutcome> {
    const completed = this.completeNode(runId, nodeId, output, recoveryClaimToken);
    if (!completed) return { completed: false, quarantined: false, caseIds: [] };
    await this.appendEvent({
      runId,
      nodeId,
      type: "node.succeeded",
      payload: { output: cloneValue(output ?? {}), attempt },
    });
    const caseIds = violations.map((violation) => {
      const id = stableSemanticCaseId(runId, violation.detectorId);
      this.semanticCaseLog.push({ id, runId, violation: cloneValue(violation) });
      return id;
    });
    for (let index = 0; index < violations.length; index += 1) {
      const violation = violations[index]!;
      await this.appendEvent({
        runId,
        nodeId,
        type: "recovery.semantic_violation",
        payload: {
          caseId: caseIds[index],
          detectorId: violation.detectorId,
          sourceNodeId: violation.sourceNodeId,
          kind: violation.kind,
          action: violation.action,
          message: violation.message,
          details: cloneValue(violation.details?.slice(0, 50)),
        },
      });
    }
    const quarantined = violations.some((violation) => violation.action === "quarantine");
    if (quarantined) this.requireRun(runId).status = "waiting";
    return { completed: true, quarantined, caseIds };
  }

  async markNodeFailed(
    runId: string,
    nodeId: string,
    error: SerializedError,
    recoveryClaimToken?: string,
  ): Promise<boolean> {
    const node = this.requireNode(runId, nodeId);
    if (node.status !== "running" || !tokenMatches(node.recoveryClaimToken, recoveryClaimToken)) {
      return false;
    }
    node.status = "failed";
    node.error = cloneValue(error);
    return true;
  }

  async markNodeWaiting(
    runId: string,
    nodeId: string,
    metadata?: unknown,
    recoveryClaimToken?: string,
  ): Promise<boolean> {
    const node = this.requireNode(runId, nodeId);
    if (node.status !== "running" || !tokenMatches(node.recoveryClaimToken, recoveryClaimToken)) {
      return false;
    }
    node.status = "waiting";
    node.state = { waiting: cloneValue(metadata ?? {}) };
    return true;
  }

  async markNodeSkipped(runId: string, nodeId: string, metadata?: unknown): Promise<void> {
    const node = this.requireNode(runId, nodeId);
    node.status = "skipped";
    node.state = { skipped: cloneValue(metadata ?? {}) };
  }

  async appendEvent(event: WorkflowEvent): Promise<void> {
    this.eventLog.push(cloneValue(event));
  }

  async updateRunStatusFromNodes(runId: string): Promise<void> {
    const run = this.requireRun(runId);
    if (isTerminalRunStatus(run.status)) return;
    const nodes = [...run.nodes.values()];
    if (nodes.some((node) => node.status === "failed")) {
      run.status = "failed";
      await this.appendEvent({
        runId,
        type: "run.failed",
        payload: { failedNodes: nodes.filter((node) => node.status === "failed").length },
      });
      return;
    }
    if (nodes.length > 0 && nodes.every((node) => !isOpenNodeStatus(node.status))) {
      run.status = "succeeded";
      await this.appendEvent({ runId, type: "run.succeeded", payload: { nodes: nodes.length } });
    }
  }

  async persistTerminalFailure(input: TerminalFailureInput): Promise<boolean> {
    const run = this.requireRun(input.runId);
    const node = this.requireNode(input.runId, input.node.id);
    if (
      run.status !== "running"
      || node.status !== "running"
      || !tokenMatches(node.recoveryClaimToken, input.recoveryClaimToken)
    ) {
      return false;
    }
    node.status = "failed";
    node.attempts = input.attempt;
    node.error = cloneValue(input.error);
    await this.appendEvent({
      runId: input.runId,
      nodeId: input.node.id,
      type: "node.failed",
      payload: { attempt: input.attempt, error: cloneValue(input.error) },
    });
    run.status = "failed";
    await this.appendEvent({
      runId: input.runId,
      type: "run.failed",
      payload: { failedNodes: [...run.nodes.values()].filter((entry) => entry.status === "failed").length },
    });
    return true;
  }

  private completeNode(
    runId: string,
    nodeId: string,
    output: unknown,
    recoveryClaimToken?: string,
  ): boolean {
    const node = this.requireNode(runId, nodeId);
    if (node.status !== "running" || !tokenMatches(node.recoveryClaimToken, recoveryClaimToken)) {
      return false;
    }
    node.status = "succeeded";
    node.state = { output: cloneValue(output ?? {}) };
    node.error = null;
    return true;
  }

  private publicationClaim(node: MutableNodeRecord): QueuePublicationClaim {
    return {
      attempt: node.attempts,
      recoveryClaimToken: node.recoveryClaimToken,
      publicationGeneration: node.publicationGeneration,
    };
  }

  private snapshotNode(node: MutableNodeRecord): InMemoryNodeSnapshot {
    return {
      ...cloneValue(node),
      output: cloneValue(nodeOutput(node)),
    };
  }

  private requireRun(runId: string): MutableRunRecord {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Run ${runId} is not seeded`);
    return run;
  }

  private requireNode(runId: string, nodeId: string): MutableNodeRecord {
    const node = this.requireRun(runId).nodes.get(nodeId);
    if (!node) throw new Error(`Node ${nodeId} is not seeded in run ${runId}`);
    return node;
  }
}
