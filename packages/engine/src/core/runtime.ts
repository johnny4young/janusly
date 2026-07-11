/**
 * `WorkflowRuntime` — the orchestrator that drives workflow execution from
 * "claim a node" through "emit completion event" and decides what comes next.
 *
 * Holds two adapters injected at construction:
 *   - `ExecutionStore` (today: `PostgresExecutionStore`) — persistence for
 *     `runs`, `run_nodes`, `run_events` plus the routing-stats update.
 *   - `QueueAdapter` (today: `BullMQQueueAdapter` composed with the DLQ
 *     adapter) — enqueueing the next node and routing terminal failures to
 *     `dead_letters`.
 *
 * Used by:
 * - `packages/engine/src/start-run.ts` — boots a new run via the runtime.
 * - `packages/engine/src/resume-run.ts` — resumes a paused run after an
 *   approval / webhook.
 * - `packages/engine/src/worker.ts` — `executeQueuedNode(runtime, job.data)`
 *   on every BullMQ message.
 *
 * Invariants:
 * - **Atomic node claim:** downstream nodes are claimed via
 *   `tryClaimNodeForQueue` (atomic `UPDATE ... WHERE status='pending'`). With
 *   multiple workers two predecessors can finish in the same instant; only
 *   one wins the claim. Don't reintroduce a non-atomic claim helper.
 * - **DLQ contract:** the queue adapter is wired to the DLQ adapter. Don't
 *   bypass the queue adapter to enqueue directly; failed-beyond-retry jobs
 *   must land in `dead_letters`.
 * - **Cross-panel reactivity:** mutations that invalidate server data must
 *   eventually trigger `bumpPlatformVersion()` on the web store — usually
 *   indirectly via the API's terminal-state response.
 * - **Audit logs:** every mutation that writes a `run_events` row carries
 *   the same shape the AI Studio consumes; don't change the event payload
 *   contract here without updating the engine event types and the web's
 *   `RunEvent` consumer.
 */

import { evaluateExpression } from "../expression";
import { logNodeEvent } from "../observability/logger";
import { workflowEvent } from "./events";
import { shouldRetry, computeRetryDelay } from "./retry-policy";
import {
  getRoutingStats,
  updateRoutingStats,
  recordWorkflowImprovement,
  rollbackWorkflowVersion,
} from "@janusly/data";
import { computeConfidence, shouldRollback } from "@janusly/domain/src/improvementEngine";
import type { DecisionCandidate } from "@janusly/domain/src/decisionEngine";
import type {
  ExecutionStore,
  QueueAdapter,
  NodeExecutorRegistry,
  ExecuteQueuedNodeInput,
  EnqueueReadyNodesInput,
  RetryPolicy,
  RunMetadata,
  SerializedError,
} from "./types";

/**
 * Normalise the loosely-typed `config.candidates` of a `router` / `router_llm`
 * node into the strict `DecisionCandidate[]` the decision engine consumes.
 *
 * Why: AI-generated workflows historically used `{ id }` for the candidate
 * identifier, while the decision engine indexes by `{ nodeId }`. Without this
 * normaliser the engine receives `nodeId: undefined`, the chosen winner is
 * `undefined`, the persisted ranking is nameless, and the replay endpoint
 * filters everything out — a silent break with no surfaced error. We accept
 * either field, prefer `nodeId` when both are present, and drop entries that
 * carry neither so the engine never sees a corrupt candidate. The validator
 * already flags missing identifiers; this is defence-in-depth at the boundary.
 */
function normalizeRouterCandidates(raw: unknown): DecisionCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: DecisionCandidate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const explicit = typeof e.nodeId === "string" && e.nodeId.trim() ? e.nodeId.trim() : null;
    const legacy = typeof e.id === "string" && e.id.trim() ? e.id.trim() : null;
    const nodeId = explicit ?? legacy;
    if (!nodeId) continue;
    const candidate: DecisionCandidate = { nodeId };
    if (typeof e.avgCost === "number") candidate.avgCost = e.avgCost;
    if (typeof e.avgLatencyMs === "number") candidate.avgLatencyMs = e.avgLatencyMs;
    if (typeof e.successRate === "number") candidate.successRate = e.successRate;
    if (e.metadata !== undefined) candidate.metadata = e.metadata;
    out.push(candidate);
  }
  return out;
}

export class WorkflowRuntime {
  constructor(
    private readonly store: ExecutionStore,
    private readonly queue: QueueAdapter,
    private readonly executors: NodeExecutorRegistry,
  ) {}

  async executeQueuedNode(input: ExecuteQueuedNodeInput): Promise<void> {
    const { runId, node } = input;
    const attempt = input.attempt ?? 1;
    const start = Date.now();

    // Pre-execution cancellation guard: a run that has already reached a
    // terminal status (cancelled / failed) must NOT have its queued jobs
    // executed. Without this, a worker pulling a job from the BullMQ queue
    // for a cancelled run would re-flip the cancelled node back to running
    // and execute its body — defeating the cancellation.
    const preStatus = await this.store.getRunStatus(runId);
    if (preStatus === "cancelled" || preStatus === "failed") {
      await this.store.appendEvent(workflowEvent({
        runId, nodeId: node.id,
        type: "node.skipped",
        payload: { reason: `Run ${preStatus}`, attempt },
      }));
      return;
    }

    // Atomic `queued → running` claim. Defends against the race window
    // between the run-status read above and this UPDATE: if cancellation
    // lands in between, the conditional WHERE clause won't match the
    // now-cancelled row, the claim fails, and we emit a skip event.
    const claimed = await this.store.markNodeRunning(runId, node.id, attempt);
    if (!claimed) {
      await this.store.appendEvent(workflowEvent({
        runId, nodeId: node.id,
        type: "node.skipped",
        payload: { reason: "Node not in queued state", attempt },
      }));
      return;
    }
    await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.running", payload: { attempt } }));

    let metadata: RunMetadata | null = null;
    try {
      // Stable per-run metadata loaded once after the claim wins. Used by
      // the router branch (org-scoped routing-stats writes + RL bandit input
      // to `decide`) and the improvement-evaluation branch
      // (workflow-version-scoped improvement ledger). Loaded post-claim so a
      // cancellation landing while a job sits queued doesn't burn an extra
      // DB round-trip — `markNodeRunning` already short-circuits when the
      // row has advanced past `queued`. Returns `null` if the run row was
      // deleted between scheduling and execution; metadata-dependent
      // branches no-op gracefully and the executor still runs so node-status
      // correctness is preserved. A lookup failure stays inside the node
      // failure handler so the already-claimed node can retry or land in DLQ.
      metadata = await this.store.getRunMetadata(runId);
      const context = await this.store.getRunContext(runId);

      if (node.type === "router" || node.type === "router_llm") {
        const candidates = normalizeRouterCandidates(node.config?.candidates);
        // RL bandit input: load the org's reinforcement counters once per
        // router decision. The decision engine only reads `pulls` /
        // `meanReward` per candidate so passing the full DB-row shape is
        // structurally compatible with the `RlStats` contract. Without this
        // load, `decide()` only saw static `avgCost`/`avgLatencyMs`/
        // `successRate` from the workflow JSON — every routing decision was
        // effectively memoryless.
        const rlStats = metadata?.orgId
          ? await getRoutingStats(metadata.orgId)
          : undefined;
        const rawStrategy = node.config?.strategy;
        // `decide()` accepts the closed enum below; anything else is silently
        // ignored so the workflow author isn't punished for a typo, but a
        // valid value is forwarded so the prompt's documented `strategy`
        // field actually changes ranking behaviour.
        const strategy: "auto" | "cheapest" | "fastest" | "balanced" | undefined =
          rawStrategy === "auto" || rawStrategy === "cheapest" || rawStrategy === "fastest" || rawStrategy === "balanced"
            ? rawStrategy
            : undefined;

        if (candidates.length > 0) {
          const { decide } = await import("@janusly/domain/src/decisionEngine");
          const decision = await decide({
            orgId: metadata?.orgId,
            candidates,
            preferences: (context as any)?.preferences,
            budget: (context as any)?.budget,
            rlStats,
            strategy,
          });

          await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "decision.made", payload: decision }));
          logNodeEvent({ runId, nodeId: node.id, type: "decision.made", attempt });
          await this.store.markNodeSucceeded(runId, node.id, { decision });

          // ROUTE the decision: mark every non-chosen candidate that is a
          // direct successor of this router as skipped BEFORE the readiness
          // scan. Without this, `enqueueReadyNodes` queues every outgoing
          // edge and the decision is decorative — both paths execute,
          // doubling cost and side effects.
          // Mirrors the condition-edge skip exactly: readiness treats
          // "skipped" as satisfied, so a join fed by the losing branch
          // still unblocks. Guards: only candidates still `pending` in the
          // context snapshot (a mis-wired candidate that already ran keeps
          // its state — validation rejects that shape on new saves via
          // `router_candidate_not_successor`).
          const chosen = decision.chosenNodeId;
          if (chosen) {
            const successorIds = new Set(
              input.workflow.edges.filter((edge) => edge.from === node.id).map((edge) => edge.to),
            );
            const statusById = context as Record<string, { status?: string } | undefined>;
            for (const candidate of candidates) {
              if (candidate.nodeId === chosen) continue;
              if (!successorIds.has(candidate.nodeId)) continue;
              if (statusById[candidate.nodeId]?.status !== "pending") continue;
              const reason = `Router ${node.id} chose ${chosen}`;
              await this.store.markNodeSkipped(runId, candidate.nodeId, { reason });
              await this.store.appendEvent(workflowEvent({ runId, nodeId: candidate.nodeId, type: "node.skipped", payload: { reason } }));
              logNodeEvent({ runId, nodeId: candidate.nodeId, type: "node.skipped" });
            }
          }

          // Re-check run status before scheduling downstream work — a
          // cancellation that lands while this node was running shouldn't
          // re-queue work for the operator who just cancelled.
          const postDecisionStatus = await this.store.getRunStatus(runId);
          if (postDecisionStatus === "cancelled" || postDecisionStatus === "failed") return;
          await this.enqueueReadyNodes(input);
          return;
        }
      }

      const result = await this.executors.execute({ runId, node, context, attempt });
      const durationMs = Date.now() - start;

      if (result?.status === "waiting") {
        await this.store.markNodeWaiting(runId, node.id, result.metadata);
        await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.waiting", payload: result }));
        logNodeEvent({ runId, nodeId: node.id, type: "node.waiting", attempt, durationMs });
        return;
      }

      // Routing-stats writes are gated on a real `orgId` from the run row,
      // not the loose context bag. The repo's own `if (!orgId) return`
      // guard remains as defence in depth, but on a healthy run the
      // metadata helper above hands it a structured value every time.
      // Independent writes (different tables, no ordering contract between
      // them) run concurrently — the completion path is a chain of
      // sequential DB round-trips and this is the one safely parallel pair.
      // The `succeeded` node transition + its `node.succeeded` event commit
      // together in one transaction (`markNodeSucceededWithEvent`), so the
      // event never repeats the (potentially 1 MB) output the node row
      // already stores.
      await Promise.all([
        updateRoutingStats({ orgId: metadata?.orgId, nodeId: node.id, reward: 1, success: true }),
        this.store.markNodeSucceededWithEvent(runId, node.id, result?.output ?? {}, attempt),
      ]);
      logNodeEvent({ runId, nodeId: node.id, type: "node.succeeded", attempt, durationMs });

      await this.evaluateImprovement(runId, context, metadata);

      // Re-check run status before scheduling downstream work. The node was
      // already running when cancellation landed, so its row stays where it
      // is — but downstream work shouldn't be queued for a cancelled run.
      const postStatus = await this.store.getRunStatus(runId);
      if (postStatus === "cancelled" || postStatus === "failed") return;

      await this.enqueueReadyNodes(input);
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const error: SerializedError = { message: err.message, name: err.name, code: err.code, statusCode: err.statusCode };
      // Carry the write-side-timeout flag into error_json / the DLQ so a
      // blind replay of a possibly-committed side effect can be gated.
      if (err?.writeSide === true) error.writeSide = true;

      await updateRoutingStats({ orgId: metadata?.orgId, nodeId: node.id, reward: -1, success: false });

      const retryPolicy = node.config?.retry as RetryPolicy | undefined;
      const maxAttempts = retryPolicy?.maxAttempts ?? 1;

      if (attempt < maxAttempts && shouldRetry(error, retryPolicy)) {
        const nextAttempt = attempt + 1;
        const delayMs = computeRetryDelay(nextAttempt, retryPolicy);
        const retryRunStatus = await this.store.getRunStatus(runId);
        if (retryRunStatus === "cancelled" || retryRunStatus === "failed") return;

        await this.store.markNodeQueued(runId, node.id, nextAttempt);
        await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.retry", payload: { attempt: nextAttempt, delayMs, error } }));
        logNodeEvent({ runId, nodeId: node.id, type: "node.retry", attempt: nextAttempt, durationMs, error });

        await this.queue.enqueueNode({ runId, nodeId: node.id, delayMs, attempt: nextAttempt });
        return;
      }

      if (this.queue.enqueueDeadLetter) {
        await this.queue.enqueueDeadLetter({
          runId,
          orgId: metadata?.orgId ?? "default",
          workflowId: metadata?.workflowId ?? input.workflow.id ?? null,
          workflow: input.workflow,
          node,
          attempt,
          error,
        });
      }

      await this.store.markNodeFailed(runId, node.id, error);
      await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.failed", payload: { error, attempt } }));
      logNodeEvent({ runId, nodeId: node.id, type: "node.failed", attempt, durationMs, error });
      await this.store.updateRunStatusFromNodes(runId);
      throw err;
    }
  }

  /**
   * Evaluate the improvement metric for a completed node and write a
   * `workflow_improvements` row when the run has enough metadata. The
   * before/after metric snapshots and `improvementAction` still flow
   * through the loose `RunContext` bag (an existing per-node convention),
   * but the org/workflow identifiers come from the structured `metadata`
   * argument so the path no longer no-ops on a missing context field.
   *
   * Skips silently when `metadata` is null (run row deleted mid-flight) or
   * when `metadata.workflowId` is null (the active version row was deleted
   * out from under the run). Both are rare-but-real races; treating them
   * as soft skips keeps the run completing instead of crashing.
   */
  private async evaluateImprovement(
    runId: string,
    context: Record<string, unknown>,
    metadata: RunMetadata | null,
  ) {
    if (!metadata?.orgId || !metadata.workflowId) return;
    const orgId = metadata.orgId;
    const workflowId = metadata.workflowId;

    const beforeMetrics = (context?.metricsBefore ?? {}) as Record<string, unknown>;
    const afterMetrics = (context?.metricsAfter ?? {}) as Record<string, unknown>;
    const { confidence, status } = computeConfidence(beforeMetrics, afterMetrics);

    await recordWorkflowImprovement({
      orgId,
      workflowId,
      baseVersion: typeof context.baseVersion === "number" ? context.baseVersion : undefined,
      newVersion: typeof context.newVersion === "number" ? context.newVersion : undefined,
      action: context.improvementAction,
      reason: "runtime_evaluation",
      beforeMetrics,
      afterMetrics,
      confidence,
      status,
    });

    await this.store.appendEvent(workflowEvent({ runId, type: "improvement.evaluated", payload: { workflowId, confidence, status } }));

    if (shouldRollback(confidence) && typeof context.baseVersion === "number") {
      await this.store.appendEvent(workflowEvent({ runId, type: "rollback.triggered", payload: { workflowId, confidence, status, targetVersion: context.baseVersion } }));

      const rollback = await rollbackWorkflowVersion({
        orgId,
        workflowId,
        targetVersion: context.baseVersion,
        // `createdBy` is the run's initiator (from the `runs` row) when
        // known, "system" otherwise. The `RunContext` bag is keyed by node
        // id, so checking `context.createdBy` would only match a node
        // literally named "createdBy" — never a real per-run author.
        createdBy: metadata.createdBy ?? "system",
        reason: "auto-rollback: low confidence",
      });

      await this.store.appendEvent(workflowEvent({ runId, type: "rollback.completed", payload: rollback }));
    }
  }

  async enqueueReadyNodes(input: EnqueueReadyNodesInput): Promise<number> {
    const { runId, workflow } = input;
    // Defense-in-depth cancellation guard. Direct callers (subworkflow
    // notifier, resume-run, the runtime itself) all pre-check, but this
    // guard catches any future caller that forgets to.
    const status = await this.store.getRunStatus(runId);
    if (status === "cancelled" || status === "failed") return 0;
    // Cheap path: the readiness scan only reads node STATUSES unless some
    // edge carries a `condition` (whose expression can reach into outputs).
    // Skipping state_json here matters — this runs after EVERY completion,
    // and full rows would move O(nodes × state size) per scan.
    const hasConditionalEdges = workflow.edges.some((edge) => edge.condition);
    const context = await this.store.getRunContext(runId, { statusesOnly: !hasConditionalEdges });

    // Readiness reads come from the context snapshot loaded above — ONE query
    // for the whole scan — instead of a per-dep + per-node `getNodeStatus`
    // round-trip (O(nodes + edges) queries on every node completion, the
    // hottest engine path). The map is seeded from every persisted row and
    // updated in place when THIS scan writes (skip → "skipped", claim →
    // "queued"), so an intra-scan skip cascade still unblocks downstream
    // dependents exactly like the per-node fresh reads did. Concurrent
    // external writes were equally racy under fresh reads; the atomic
    // `tryClaimNodeForQueue` claim remains the multi-worker correctness gate,
    // and every completion triggers its own scan, so a node a stale snapshot
    // misses here is picked up by the completing sibling's scan.
    const statuses = new Map<string, string | undefined>(
      Object.entries(context as Record<string, { status?: string } | undefined>)
        .map(([nodeId, entry]) => [nodeId, entry?.status]),
    );
    let queued = 0;

    for (const node of workflow.nodes) {
      const incomingEdges = workflow.edges.filter((edge) => edge.to === node.id);
      const deps = incomingEdges.map((edge) => edge.from);
      const ready = deps.every((depId) => ["succeeded", "skipped"].includes(statuses.get(depId) ?? ""));
      const currentStatus = statuses.get(node.id);

      if (!ready || currentStatus !== "pending") continue;

      let shouldRun = false;
      for (const edge of incomingEdges) {
        if (!edge.condition) { shouldRun = true; break; }
        const result = evaluateExpression(edge.condition, { context, inputs: {} });
        if (result) { shouldRun = true; break; }
      }

      if (!shouldRun) {
        statuses.set(node.id, "skipped");
        await this.store.markNodeSkipped(runId, node.id, { reason: "Condition not met" });
        await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.skipped", payload: { reason: "Condition not met" } }));
        logNodeEvent({ runId, nodeId: node.id, type: "node.skipped" });
        continue;
      }

      const claimed = await this.store.tryClaimNodeForQueue(runId, node.id, 1);
      if (!claimed) continue;
      statuses.set(node.id, "queued");
      await this.queue.enqueueNode({ runId, nodeId: node.id, attempt: 1 });
      await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.queued" }));
      logNodeEvent({ runId, nodeId: node.id, type: "node.queued", attempt: 1 });
      queued++;
    }

    if (queued === 0) {
      await this.store.updateRunStatusFromNodes(runId);
      await this.store.appendEvent(workflowEvent({ runId, type: "run.status_checked" }));
    }

    return queued;
  }
}
