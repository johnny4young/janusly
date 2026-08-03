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
import { materializeWaitingCheckpointMetadata } from "../waiting-time";
import { logNodeEvent } from "../observability/logger";
import { incNodeFailure, incNodeRetry, recordNodeDuration } from "../observability/metrics";
import { workflowEvent } from "./events";
import { shouldRetry, computeRetryDelay } from "./retry-policy";
import { decideTransient, isTransientTierEnabled, transientAttemptFromCounters } from "./transient-tier";
import { evaluateSemanticOutcome } from "../semantic-outcomes";
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
    const { runId, node, recoveryClaimToken } = input;
    const attempt = input.attempt ?? 1;
    const publicationGeneration = input.publicationGeneration ?? 0;
    const start = Date.now();

    // The production store serializes this queued-generation claim with the
    // run row. A failed-run consumer durably restores the exact generation
    // to `pending`; a concurrent subworkflow reattachment that reopens first
    // lets this same job proceed. This removes the stale status-read window.
    const executionClaim = await this.store.claimNodeForExecution(
      runId,
      node.id,
      attempt,
      recoveryClaimToken,
      publicationGeneration,
    );
    if (executionClaim !== "claimed") {
      if (executionClaim !== "not_claimed") return;
      if (recoveryClaimToken) return;
      await this.store.appendEvent(workflowEvent({
        runId, nodeId: node.id,
        type: "node.skipped",
        payload: { reason: "Node not in queued state", attempt },
      }));
      return;
    }
    await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.running", payload: { attempt } }));

    let metadata: RunMetadata | null = null;
    let writeSideExecuted = false;
    try {
      // Stable per-run metadata loaded once after the claim wins. Used by
      // the router branch (org-scoped routing-stats writes + RL bandit input
      // to `decide`) and the improvement-evaluation branch
      // (workflow-version-scoped improvement ledger). Loaded post-claim so a
      // cancellation landing while a job sits queued doesn't burn an extra
      // DB round-trip — `claimNodeForExecution` already short-circuits when the
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
          const semanticOutcome = evaluateSemanticOutcome({
            contract: input.workflow.recovery?.contract,
            sourceNodeId: node.id,
            output: { decision },
            context,
          });
          const completion = semanticOutcome.evaluated > 0
            ? await this.store.markNodeSucceededWithOutcome(
                runId,
                node.id,
                { decision },
                attempt,
                semanticOutcome.violations,
                recoveryClaimToken,
              )
            : {
                completed: await this.store.markNodeSucceeded(
                  runId,
                  node.id,
                  { decision },
                  recoveryClaimToken,
                ),
                quarantined: false,
                caseIds: [],
              };
          const completed = completion.completed;
          /*
           * The semantic gate is committed with node success. Routing state
           * can still be made deterministic below, but no successor is
           * published while the run remains quarantined.
           */
          if (!completed) return;
          const durationMs = Date.now() - start;
          recordNodeDuration(durationMs, { node_type: node.type });

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
          if (
            postDecisionStatus === "cancelled" ||
            postDecisionStatus === "failed" ||
            postDecisionStatus === "waiting"
          ) {
            return;
          }
          await this.enqueueReadyNodes(input);
          return;
        }
      }

      const result = await this.executors.execute({ runId, node, context, attempt, recoveryClaimToken });
      writeSideExecuted = result?.status !== "waiting" && result?.writeSideExecuted === true;
      const durationMs = Date.now() - start;

      if (result?.status === "waiting") {
        if (result.checkpointPersisted) {
          recordNodeDuration(durationMs, { node_type: node.type });
          logNodeEvent({ runId, nodeId: node.id, type: "node.waiting", attempt, durationMs });
          return;
        }
        const checkpointAt = new Date();
        const metadata = {
          ...materializeWaitingCheckpointMetadata(result.metadata, checkpointAt.getTime()),
          waitingSince: checkpointAt.toISOString(),
        };
        const waiting = await this.store.markNodeWaiting(runId, node.id, metadata, recoveryClaimToken);
        if (!waiting) return;
        recordNodeDuration(durationMs, { node_type: node.type });
        await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.waiting", payload: { ...result, metadata } }));
        logNodeEvent({ runId, nodeId: node.id, type: "node.waiting", attempt, durationMs });
        return;
      }

      // Routing-stats writes are gated on a real `orgId` from the run row,
      // not the loose context bag. The repo's own `if (!orgId) return`
      // guard remains as defence in depth, but on a healthy run the
      // metadata helper above hands it a structured value every time.
      // The `succeeded` node transition + its `node.succeeded` event commit
      // together in one transaction (`markNodeSucceededWithEvent`), so the
      // event never repeats the (potentially 1 MB) output the node row
      // already stores.
      const semanticOutcome = evaluateSemanticOutcome({
        contract: input.workflow.recovery?.contract,
        sourceNodeId: node.id,
        output: result?.output ?? {},
        context,
      });
      const completion = semanticOutcome.evaluated > 0
        ? await this.store.markNodeSucceededWithOutcome(
            runId,
            node.id,
            result?.output ?? {},
            attempt,
            semanticOutcome.violations,
            recoveryClaimToken,
          )
        : {
            completed: await this.store.markNodeSucceededWithEvent(
              runId,
              node.id,
              result?.output ?? {},
              attempt,
              recoveryClaimToken,
            ),
            quarantined: false,
            caseIds: [],
          };
      if (!completion.completed) return;
      recordNodeDuration(durationMs, { node_type: node.type });
      await updateRoutingStats({ orgId: metadata?.orgId, nodeId: node.id, reward: 1, success: true });
      logNodeEvent({ runId, nodeId: node.id, type: "node.succeeded", attempt, durationMs });

      await this.evaluateImprovement(runId, context, metadata);

      // Re-check run status before scheduling downstream work. The node was
      // already running when cancellation landed, so its row stays where it
      // is — but downstream work shouldn't be queued for a cancelled run.
      const postStatus = await this.store.getRunStatus(runId);
      if (
        postStatus === "cancelled" ||
        postStatus === "failed" ||
        postStatus === "waiting"
      ) {
        return;
      }

      await this.enqueueReadyNodes(input);
    } catch (err: any) {
      const durationMs = Date.now() - start;
      const error: SerializedError = {
        message: err.message,
        name: err.name,
        code: err.code,
        statusCode: err.statusCode,
        details: err.details,
      };
      if (writeSideExecuted) error.writeSide = true;
      // Carry the write-side-timeout flag into error_json / the DLQ so a
      // blind replay of a possibly-committed side effect can be gated.
      if (err?.writeSide === true) error.writeSide = true;

      const retryPolicy = node.config?.retry as RetryPolicy | undefined;
      const maxAttempts = retryPolicy?.maxAttempts ?? 1;

      // A timed-out or partially failed write-side execution may already have
      // committed effects. Never retry it as a whole node: replay requires an
      // operator decision rather than risking duplicate external writes.
      if (error.writeSide !== true && attempt < maxAttempts && shouldRetry(error, retryPolicy)) {
        const nextAttempt = attempt + 1;
        const delayMs = computeRetryDelay(nextAttempt, retryPolicy);
        const retryRunStatus = await this.store.getRunStatus(runId);
        if (retryRunStatus === "cancelled" || retryRunStatus === "failed") return;

        const queued = await this.store.markNodeQueued(
          runId,
          node.id,
          nextAttempt,
          recoveryClaimToken,
          delayMs,
        );
        if (!queued) return;
        recordNodeDuration(durationMs, { node_type: node.type });
        incNodeRetry({ node_type: node.type });
        await updateRoutingStats({ orgId: metadata?.orgId, nodeId: node.id, reward: -1, success: false });
        await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.retry", payload: { attempt: nextAttempt, delayMs, error } }));
        logNodeEvent({ runId, nodeId: node.id, type: "node.retry", attempt: nextAttempt, durationMs, error });

        await this.queue.enqueueNode({
          runId,
          nodeId: node.id,
          delayMs,
          attempt: queued.attempt,
          publicationGeneration: queued.publicationGeneration,
          ...(queued.recoveryClaimToken
            ? { recoveryClaimToken: queued.recoveryClaimToken }
            : {}),
        });
        await this.store.markQueuePublicationSucceeded(
          runId,
          node.id,
          queued.attempt,
          queued.publicationGeneration,
          queued.recoveryClaimToken ?? undefined,
        );
        return;
      }

      // Transient fast path: a 429 / dropped connection / gateway
      // timeout that already burned the node's own retries gets one more
      // deterministic, zero-LLM ladder before the DLQ — so the operator is
      // paged for the interesting failures, not the ones that heal. The
      // decision is pure (`decideTransient`); write-side errors and spent
      // ladders fall straight through to `persistTerminalFailure` below.
      const transientDecision = decideTransient({
        error,
        transientAttempt: transientAttemptFromCounters(attempt, maxAttempts),
        enabled: isTransientTierEnabled(),
      });
      if (transientDecision.kind === "transient_retry") {
        const transientRunStatus = await this.store.getRunStatus(runId);
        if (transientRunStatus === "cancelled" || transientRunStatus === "failed") return;

        // Same claim → publish → mark machinery as the ordinary retry above:
        // the attempt counter carries the ladder position, so a crash resumes
        // at the right rung and a lost claim means another worker owns it.
        const queued = await this.store.markNodeQueued(
          runId,
          node.id,
          attempt + 1,
          recoveryClaimToken,
          transientDecision.delayMs,
        );
        if (!queued) return;

        recordNodeDuration(durationMs, { node_type: node.type });
        incNodeRetry({ node_type: node.type });

        await this.store.appendEvent(workflowEvent({
          runId,
          nodeId: node.id,
          type: "node.transient_retry",
          payload: {
            attempt: queued.attempt,
            delayMs: transientDecision.delayMs,
            transientClass: transientDecision.transientClass,
            transientAttempt: transientDecision.transientAttempt,
            ladderLength: transientDecision.ladderLength,
            error,
          },
        }));
        logNodeEvent({
          runId,
          nodeId: node.id,
          type: "node.transient_retry",
          attempt: queued.attempt,
          durationMs,
          error,
        });

        await this.queue.enqueueNode({
          runId,
          nodeId: node.id,
          delayMs: transientDecision.delayMs,
          attempt: queued.attempt,
          publicationGeneration: queued.publicationGeneration,
          ...(queued.recoveryClaimToken
            ? { recoveryClaimToken: queued.recoveryClaimToken }
            : {}),
        });
        await this.store.markQueuePublicationSucceeded(
          runId,
          node.id,
          queued.attempt,
          queued.publicationGeneration,
          queued.recoveryClaimToken ?? undefined,
        );
        return;
      }

      const failed = await this.queue.persistTerminalFailure({
        runId,
        orgId: metadata?.orgId ?? "default",
        workflowId: metadata?.workflowId ?? input.workflow.id ?? null,
        workflow: input.workflow,
        node,
        attempt,
        error,
        recoveryClaimToken,
      });
      if (!failed) return;

      recordNodeDuration(durationMs, { node_type: node.type });
      incNodeFailure({ node_type: node.type });
      await updateRoutingStats({ orgId: metadata?.orgId, nodeId: node.id, reward: -1, success: false });
      logNodeEvent({ runId, nodeId: node.id, type: "node.failed", attempt, durationMs, error });
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
    if (
      status === "cancelled" ||
      status === "failed" ||
      status === "waiting"
    ) {
      return 0;
    }
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
    // "queued"). Concurrent external writes were equally racy under fresh
    // reads; the atomic `tryClaimNodeForQueue` claim remains the multi-worker
    // correctness gate, and every completion triggers its own scan, so a node
    // a stale snapshot misses here is picked up by the completing sibling's
    // scan.
    const statuses = new Map<string, string | undefined>(
      Object.entries(context as Record<string, { status?: string } | undefined>)
        .map(([nodeId, entry]) => [nodeId, entry?.status]),
    );
    let queued = 0;

    // The scan loops to a FIXPOINT (mirroring the Go pilot's
    // scheduleDownstream): a single declaration-order pass strands any
    // dependent declared BEFORE a node this same pass skips — the dependent
    // was visited while its dep was still "pending", becomes ready the
    // moment the skip lands, and nothing external ever re-triggers a scan
    // (queued === 0 parks the run as "running" forever). Each productive
    // pass moves ≥1 node out of "pending" in the local map and a node
    // leaves "pending" at most once, so the loop is bounded by
    // nodes.length passes plus one final no-change pass; repeat visits are
    // in-memory only (`currentStatus !== "pending"` guards every write).
    for (let changed = true; changed; ) {
      changed = false;
      for (const node of workflow.nodes) {
        const incomingEdges = workflow.edges.filter((edge) => edge.to === node.id);
        const deps = incomingEdges.map((edge) => edge.from);
        const ready = deps.every((depId) => ["succeeded", "skipped"].includes(statuses.get(depId) ?? ""));
        const currentStatus = statuses.get(node.id);

        if (!ready || currentStatus !== "pending") continue;

        // Roots have no incoming edges and are unconditionally runnable. This
        // matters when the durable publication reconciler restores a consumed
        // root generation to `pending`: routing it through the ordinary DAG
        // scan must republish the root, not reinterpret it as a condition miss.
        let shouldRun = incomingEdges.length === 0;
        for (const edge of incomingEdges) {
          if (!edge.condition) { shouldRun = true; break; }
          const result = evaluateExpression(edge.condition, { context, inputs: {} });
          if (result) { shouldRun = true; break; }
        }

        if (!shouldRun) {
          statuses.set(node.id, "skipped");
          changed = true;
          await this.store.markNodeSkipped(runId, node.id, { reason: "Condition not met" });
          await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.skipped", payload: { reason: "Condition not met" } }));
          logNodeEvent({ runId, nodeId: node.id, type: "node.skipped" });
          continue;
        }

        const claimed = await this.store.tryClaimNodeForQueue(runId, node.id, 1);
        if (!claimed) continue;
        statuses.set(node.id, "queued");
        changed = true;
        await this.queue.enqueueNode({
          runId,
          nodeId: node.id,
          attempt: claimed.attempt,
          publicationGeneration: claimed.publicationGeneration,
          ...(claimed.recoveryClaimToken ? { recoveryClaimToken: claimed.recoveryClaimToken } : {}),
        });
        await this.store.markQueuePublicationSucceeded(
          runId,
          node.id,
          claimed.attempt,
          claimed.publicationGeneration,
          claimed.recoveryClaimToken ?? undefined,
        );
        await this.store.appendEvent(workflowEvent({ runId, nodeId: node.id, type: "node.queued" }));
        logNodeEvent({ runId, nodeId: node.id, type: "node.queued", attempt: claimed.attempt });
        queued++;
      }
    }

    if (queued === 0) {
      await this.store.updateRunStatusFromNodes(runId);
      await this.store.appendEvent(workflowEvent({ runId, type: "run.status_checked" }));
    }

    return queued;
  }
}
