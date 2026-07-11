/**
 * Runs resource — the primary surface of the Janusly SDK.
 *
 * Exposes typed methods over the existing HTTP API for workflow run
 * lifecycle: start, list (async iterator over the capped run list), get,
 * poll-until-terminal, stream-events (head-polling iterator), resume-node,
 * and cancel.
 *
 * The polling-backed `streamEvents` is intentionally shaped as an async
 * iterator: when the server gains a server-sent events transport, the
 * SDK swaps the internal implementation transparently — callers see no
 * API change.
 */

import { JanuslyApiError, JanuslyTimeoutError } from "../errors.ts";
import { sendApiRequest } from "../request.ts";
import {
  TERMINAL_RUN_STATUSES,
  type JanuslyClientConfig,
  type JanuslyRequestOptions,
  type RunDetails,
  type RunEvent,
  type RunStatus,
  type RunSummary,
} from "../types.ts";

const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_POLL_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_LIST_PAGE_SIZE = 100;

type RunsPage = {
  runs: RunSummary[];
  /** Server-side cursor for the next page. Null when no more pages. */
  nextCursor?: string | null;
};

/** Current response shape from `GET /runs` plus future paginated shape. */
type RunsListResponse = RunSummary[] | RunsPage;

/** Internal response shape from `GET /workflows/latest?workflowId=…`. */
type WorkflowVersionResponse = {
  dagJson?: unknown;
} | null;

/**
 * Public RunsResource — bound to a single `JanuslyClient` config. All
 * methods route through `sendApiRequest` so auth headers, retry, and
 * AbortSignal composition apply uniformly.
 */
export class RunsResource {
  private readonly config: JanuslyClientConfig;

  constructor(config: JanuslyClientConfig) {
    this.config = config;
  }

  /**
   * Start the latest saved workflow version.
   *
   * The current API starts a workflow DAG, not a bare workflow id. The SDK
   * keeps the public helper ergonomic by first loading `/workflows/latest`
   * for the tenant-scoped workflow id, then posting that version's `dagJson`
   * to `/start` with the optional workflow input.
   */
  async start(
    input: { workflowId: string; input?: Record<string, unknown> },
    options?: JanuslyRequestOptions,
  ): Promise<{ runId: string }> {
    const params = new URLSearchParams();
    params.set("workflowId", input.workflowId);
    const latest = (await sendApiRequest(
      this.config,
      {
        method: "GET",
        path: `/workflows/latest?${params.toString()}`,
      },
      options,
    )) as WorkflowVersionResponse;
    const workflow = extractWorkflowDag(latest, input.workflowId);
    const body: Record<string, unknown> = { workflow };
    if (input.input !== undefined) body.input = input.input;
    const res = (await sendApiRequest(
      this.config,
      { method: "POST", path: "/start", body },
      options,
    )) as { runId: string };
    return res;
  }

  /**
   * GET /run?runId=… — fetch a single run with paginated events.
   *
   * Use `events.eventsCursor` from a prior response to walk older events:
   * pass it as `query.eventsCursor` to the next call. `events.eventsHasMore`
   * indicates whether more pages remain.
   */
  async get(
    runId: string,
    query?: { eventsLimit?: number; eventsCursor?: string },
    options?: JanuslyRequestOptions,
  ): Promise<RunDetails> {
    const params = new URLSearchParams();
    params.set("runId", runId);
    if (query?.eventsLimit !== undefined) params.set("eventsLimit", String(query.eventsLimit));
    if (query?.eventsCursor !== undefined) params.set("eventsCursor", query.eventsCursor);
    return (await sendApiRequest(
      this.config,
      { method: "GET", path: `/run?${params.toString()}` },
      options,
    )) as RunDetails;
  }

  /**
   * GET /runs — async iterator over the server's capped run-list response.
   *
   * The current API returns one capped array (default 100, max 200). This
   * iterator shape still lets callers `break` early without buffering the
   * entire list, and it is future-compatible with a `{ runs, nextCursor }`
   * response if the API adds cursor pagination later.
   */
  list(
    query?: { workflowId?: string; limit?: number },
    options?: JanuslyRequestOptions,
  ): AsyncIterable<RunSummary> {
    const config = this.config;
    return {
      async *[Symbol.asyncIterator]() {
        const softLimit = query?.limit;
        let yielded = 0;
        let cursor: string | undefined;
        const pageSize = DEFAULT_LIST_PAGE_SIZE;

        while (true) {
          if (options?.signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          const params = new URLSearchParams();
          params.set("limit", String(pageSize));
          if (query?.workflowId) params.set("workflowId", query.workflowId);
          if (cursor) params.set("cursor", cursor);

          const page = coerceRunsListResponse(await sendApiRequest(
            config,
            { method: "GET", path: `/runs?${params.toString()}` },
            options,
          ));

          for (const run of page.runs) {
            if (softLimit !== undefined && yielded >= softLimit) return;
            yield run;
            yielded += 1;
          }

          if (!page.nextCursor) return;
          cursor = page.nextCursor;
        }
      },
    };
  }

  /**
   * Polls `GET /run` until the run reaches a terminal status (succeeded,
   * failed, cancelled, timed_out). Throws `JanuslyTimeoutError` after
   * `timeoutMs` (default 5 minutes). Honours `options.signal` for early
   * cancellation.
   *
   * The wait between polls uses Promise-wrapped `setTimeout` so the loop
   * yields cleanly to the event loop — no busy-wait.
   */
  async pollUntilTerminal(
    runId: string,
    query?: { intervalMs?: number; timeoutMs?: number },
    options?: JanuslyRequestOptions,
  ): Promise<RunDetails> {
    const intervalMs = Math.max(50, query?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const timeoutMs = Math.max(intervalMs, query?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;

    while (true) {
      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const details = await this.get(runId, undefined, options);
      if (TERMINAL_RUN_STATUSES.has(details.run.status)) {
        return details;
      }
      if (Date.now() >= deadline) {
        throw new JanuslyTimeoutError(
          `Run ${runId} did not reach a terminal status within ${timeoutMs}ms`,
        );
      }
      await sleepWithAbort(intervalMs, options?.signal);
    }
  }

  /**
   * Async iterator over run-timeline events for a single run. Internally
   * polls the head of `GET /run`, emitting each new event in chronological
   * order. Older-history pagination stays available through `get()`.
   * The iterator exits automatically when the run's status enters the
   * terminal set.
   *
   * Consumer drives the loop — each `for await` step pulls the next
   * event. If the caller `break`s early, the SDK stops polling on the
   * next iteration boundary. Cancellation via `options.signal` is
   * immediate (within one `intervalMs` window).
   *
   * `sinceCursor` semantics: the server's events cursor walks BACKWARD
   * (toward older history), so passing one as `sinceCursor` makes the
   * FIRST poll fetch the page immediately older than that cursor. After
   * that first page, subsequent polls always hit the head of the stream.
   * This is useful for resuming from a known cursor with a single
   * back-fill page; it is NOT a "start from this point and stream
   * forward" knob. Callers wanting forward-only streaming should omit
   * `sinceCursor` and dedup against their own ledger by `event.id`.
   */
  streamEvents(
    runId: string,
    query?: { intervalMs?: number; sinceCursor?: string },
    options?: JanuslyRequestOptions,
  ): AsyncIterable<RunEvent> {
    const intervalMs = Math.max(50, query?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const config = this.config;
    const seen = new Set<string>();
    return {
      async *[Symbol.asyncIterator]() {
        let cursor: string | undefined = query?.sinceCursor;
        let lastStatus: RunStatus | null = null;

        while (true) {
          if (options?.signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          const params = new URLSearchParams();
          params.set("runId", runId);
          if (cursor) params.set("eventsCursor", cursor);
          const details = (await sendApiRequest(
            config,
            { method: "GET", path: `/run?${params.toString()}` },
            options,
          )) as RunDetails;

          // The API's run paginator already returns events oldest-first
          // within each page. Preserve that order for chronological consumers.
          for (const event of details.events) {
            if (seen.has(event.id)) continue;
            seen.add(event.id);
            yield event;
          }

          // `eventsCursor` walks older history pages; streaming wants the
          // head of the run timeline on each poll so new events can appear.
          cursor = undefined;
          lastStatus = details.run.status;

          if (TERMINAL_RUN_STATUSES.has(lastStatus)) {
            return;
          }
          await sleepWithAbort(intervalMs, options?.signal);
        }
      },
    };
  }

  /**
   * POST /resume — resume a waiting `human_form` or `approval` node.
   *
   * For `human_form` nodes the engine emits a signed `resumeToken` in
   * the `node.waiting` event payload; pass it verbatim. For `approval`
   * nodes the token is optional.
   */
  async resumeNode(
    input: {
      runId: string;
      nodeId: string;
      input?: Record<string, unknown>;
      resumeToken?: string;
    },
    options?: JanuslyRequestOptions,
  ): Promise<{ resumed: true } | { errors: string[] }> {
    const body: Record<string, unknown> = { runId: input.runId, nodeId: input.nodeId };
    if (input.input !== undefined) body.input = input.input;
    if (input.resumeToken !== undefined) body.resumeToken = input.resumeToken;
    return (await sendApiRequest(
      this.config,
      { method: "POST", path: "/resume", body },
      options,
    )) as { resumed: true } | { errors: string[] };
  }

  /**
   * POST /run/cancel — cancel an in-flight run.
   *
   * Flips the run and its non-running nodes to `cancelled`; the worker's
   * currently-running job (if any) drains to completion — the
   * cancelled-stays-cancelled rollup absorbs those post-cancel writes. An
   * optional `reason` is recorded on the cancellation audit. A run already in
   * a terminal state (succeeded / failed / cancelled / timed_out) is rejected
   * with `409` (surfaced as a `JanuslyApiError`).
   */
  async cancel(
    input: { runId: string; reason?: string },
    options?: JanuslyRequestOptions,
  ): Promise<{ runId: string; status: "cancelled" }> {
    const body: Record<string, unknown> = { runId: input.runId };
    if (input.reason !== undefined) body.reason = input.reason;
    return (await sendApiRequest(
      this.config,
      { method: "POST", path: "/run/cancel", body },
      options,
    )) as { runId: string; status: "cancelled" };
  }
}

function extractWorkflowDag(latest: WorkflowVersionResponse, workflowId: string): Record<string, unknown> {
  if (!latest || typeof latest !== "object" || Array.isArray(latest)) {
    throw new JanuslyApiError(`Workflow ${workflowId} was not found`, {
      statusCode: 404,
      code: "workflow_not_found",
      params: { workflowId },
    });
  }
  const dag = latest.dagJson;
  if (!dag || typeof dag !== "object" || Array.isArray(dag)) {
    throw new JanuslyApiError(`Workflow ${workflowId} has no runnable DAG`, {
      statusCode: 422,
      code: "workflow_dag_missing",
      params: { workflowId },
    });
  }
  return dag as Record<string, unknown>;
}

function coerceRunsListResponse(raw: unknown): RunsPage {
  const response = raw as RunsListResponse;
  if (Array.isArray(response)) {
    return { runs: response, nextCursor: null };
  }
  if (response && typeof response === "object" && Array.isArray(response.runs)) {
    return response;
  }
  return { runs: [], nextCursor: null };
}

/**
 * Sleep helper that honours an AbortSignal. Resolves after `ms` OR
 * rejects with an `AbortError` immediately when the signal fires.
 */
function sleepWithAbort(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    let onAbort: (() => void) | null = null;
    const handle = setTimeout(() => {
      if (onAbort && signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(handle);
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    onAbort = () => {
      clearTimeout(handle);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
