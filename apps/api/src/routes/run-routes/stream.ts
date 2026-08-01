/** Live run streaming routes. */

import { and, asc, eq, gt, or } from "drizzle-orm";

import { getOrgConfigSnapshot } from "@janusly/data";
import { db, runEvents, runs } from "@janusly/db";
import type { PublishedRunEvent } from "@janusly/engine/src/run-event-stream";
import { isTerminalRunStatus } from "@janusly/shared/src/status";

import { corsHeaders, sendEventFrame, sendError, sendSseComment } from "../../http";
import { parseEventsCursor } from "../../run-pagination";
import { getRunStreamHub } from "../../run-stream";
import type { Route } from "../../routes";

// SSE heartbeat cadence. The server destroys idle sockets after 60s
// (`server.setTimeout`); a comment well under that keeps an idle run's
// stream alive without a flood of frames.
const STREAM_HEARTBEAT_MS = 25_000;
// After a run reaches a terminal status, hold the stream open briefly so
// trailing node events flush, then close server-side.
const STREAM_TERMINAL_GRACE_MS = 30_000;
// Client reconnect backoff hint (SSE `retry:` field), in ms.
const STREAM_RETRY_HINT_MS = 3_000;
// Cap the per-connect Last-Event-ID catch-up replay so a long-disconnected
// client can't pull an unbounded backlog in one shot.
const STREAM_CATCHUP_MAX = 500;
// Bound publications waiting behind catch-up or socket backpressure. Persisted
// events remain recoverable through Last-Event-ID, so closing and reconnecting
// is safer than allowing one slow client to consume unbounded process memory.
const STREAM_LIVE_QUEUE_MAX_BYTES = 1_048_576;

function publishedRunEventBytes(event: PublishedRunEvent): number {
  try {
    return Buffer.byteLength(JSON.stringify(event), "utf8") + 128;
  } catch {
    return STREAM_LIVE_QUEUE_MAX_BYTES + 1;
  }
}

export const runStreamRoutes: Route[] = [
  // Live run stream (SSE over Redis pub/sub). MUST precede the `/runs` list
  // matcher below — both are GET and `/runs/<id>/stream` starts with `/runs`,
  // so first-match-wins requires this entry first. Events are fanned from the
  // engine's run-event seam through Redis; the per-run channel + the
  // `run.orgId === auth.orgId` gate + the hub's per-publish org re-check are
  // the tenant boundary. Initial timeline history comes from the regular
  // `/run` fetch; this stream carries live signals plus a bounded overlap/gap
  // replay from the newest `Last-Event-ID` (or the beginning when the timeline
  // was empty at connect time).
  { method: "GET", match: (url) => /^\/runs\/[^/?]+\/stream(\?|$)/.test(url), permission: "runs.read",
    handler: async ({ req, res, auth }) => {
      const url = new URL(req.url ?? "", "http://localhost");
      const runId = decodeURIComponent(url.pathname.split("/")[2] ?? "");
      if (!runId) return sendError(res, "runs_run_id_required", "runId is required", 400);

      const run = await db
        .select({ status: runs.status })
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.orgId, auth.orgId)));
      if (!run[0]) return sendError(res, "runs_forbidden", "Forbidden", 403);

      const { runs: runConfig } = await getOrgConfigSnapshot(auth.orgId);

      let torn = false;
      let graceTimer: ReturnType<typeof setTimeout> | null = null;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let heartbeatWaitingForDrain = false;
      let removeSubscriber: (() => void) | null = null;
      const teardown = (endResponse: boolean) => {
        if (torn) return;
        torn = true;
        if (heartbeat) clearInterval(heartbeat);
        if (graceTimer) clearTimeout(graceTimer);
        removeSubscriber?.();
        if (endResponse && !res.writableEnded) res.end();
      };
      function armGraceClose() {
        if (graceTimer || torn) return;
        graceTimer = setTimeout(() => teardown(true), STREAM_TERMINAL_GRACE_MS);
        graceTimer.unref?.();
      }

      const waitForDrain = async () => {
        if (torn || res.writableEnded) return;
        await new Promise<void>((resolve) => {
          const done = () => {
            res.off("drain", done);
            res.off("close", done);
            res.off("finish", done);
            req.off("close", done);
            resolve();
          };
          res.once("drain", done);
          res.once("close", done);
          res.once("finish", done);
          req.once("close", done);
        });
      };
      const writeSseFrame = async (frame: { id?: string; event?: string; data: unknown }) => {
        if (torn || res.writableEnded) return;
        if (!sendEventFrame(res, frame)) await waitForDrain();
      };
      const writeFrame = async (event: PublishedRunEvent) => {
        if (event.kind === "event") {
          await writeSseFrame({ id: `${event.createdAt}|${event.id}`, event: "run-event", data: event });
          return;
        }
        await writeSseFrame({ event: "run-status", data: event });
        if (isTerminalRunStatus(event.status)) armGraceClose();
      };

      // Subscribe before reading the reconnect gap so no publication can land
      // between the database snapshot and the live channel. Live frames are
      // buffered until catch-up finishes; otherwise a newly-published event
      // could advance the browser's Last-Event-ID beyond an older missing page.
      let catchingUp = true;
      const bufferedLiveFrames: Array<{ event: PublishedRunEvent; bytes: number }> = [];
      let pendingLiveBytes = 0;
      let deliveryTail = Promise.resolve();
      const writeLiveFrame = (event: PublishedRunEvent) => {
        const bytes = publishedRunEventBytes(event);
        if (pendingLiveBytes + bytes > STREAM_LIVE_QUEUE_MAX_BYTES) {
          teardown(true);
          return;
        }
        pendingLiveBytes += bytes;
        if (catchingUp) {
          bufferedLiveFrames.push({ event, bytes });
          return;
        }
        deliveryTail = deliveryTail
          .then(() => writeFrame(event))
          .catch(() => teardown(true))
          .finally(() => { pendingLiveBytes -= bytes; });
      };

      const hub = getRunStreamHub();
      const added = hub.addSubscriber(
        runId,
        auth.orgId,
        writeLiveFrame,
        runConfig.streamMaxSubscriptions,
        () => teardown(res.headersSent),
      );
      if (!added.ok) {
        return sendError(res, "stream_cap_exceeded", "Too many live run streams for this organization", 429);
      }
      removeSubscriber = added.remove;

      try {
        // SUBSCRIBE acknowledgment is the ordering barrier: only after it
        // resolves can the database catch-up snapshot safely overlap with the
        // live publication buffer.
        await added.ready;
      } catch {
        teardown(false);
        if (!res.headersSent && !res.writableEnded) {
          return sendError(res, "stream_unavailable", "Live run stream is unavailable", 503);
        }
        return;
      }
      if (torn) return;

      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        // Disable proxy buffering (nginx) so frames flush immediately.
        "X-Accel-Buffering": "no",
        ...corsHeaders(res),
      });
      req.on("close", () => teardown(false));

      try {
        if (!res.write(`retry: ${STREAM_RETRY_HINT_MS}\n\n`)) await waitForDrain();
        if (!sendSseComment(res, "connected")) await waitForDrain();

        heartbeat = setInterval(() => {
          if (torn || res.writableEnded) return;
          try {
            if (!heartbeatWaitingForDrain && !sendSseComment(res, "keep-alive")) {
              heartbeatWaitingForDrain = true;
              void waitForDrain()
                .catch(() => teardown(true))
                .finally(() => { heartbeatWaitingForDrain = false; });
            }
          } catch {
            teardown(true);
          }
        }, STREAM_HEARTBEAT_MS);

        // Replay from the client's composite cursor. With no Last-Event-ID we
        // replay from the beginning: this closes the initial-empty-timeline
        // race between the regular `/run` fetch and Redis subscription. Web
        // state dedupes the intentional overlap by event id.
        const rawLastId = req.headers["last-event-id"];
        const lastEventId = Array.isArray(rawLastId) ? rawLastId[0] : rawLastId;
        const cursor = parseEventsCursor(lastEventId ?? null);
        const eventBoundary = cursor
          ? or(
              gt(runEvents.createdAt, cursor.createdAt),
              and(eq(runEvents.createdAt, cursor.createdAt), gt(runEvents.id, cursor.id)),
            )
          : undefined;
        const rows = await db
          .select()
          .from(runEvents)
          .where(eventBoundary
            ? and(eq(runEvents.runId, runId), eventBoundary)
            : eq(runEvents.runId, runId))
          .orderBy(asc(runEvents.createdAt), asc(runEvents.id))
          // Read one sentinel row beyond the wire cap so the protocol can
          // report that another bounded reconnect page is required.
          .limit(STREAM_CATCHUP_MAX + 1);
        if (torn) return;

        const replayRows = rows.slice(0, STREAM_CATCHUP_MAX);
        for (const row of replayRows) {
          await writeFrame({
            kind: "event",
            id: row.id,
            nodeId: row.nodeId,
            type: row.type,
            payload: row.payload,
            createdAt: (row.createdAt ?? new Date()).toISOString(),
          });
          if (torn) return;
        }
        if (rows.length > STREAM_CATCHUP_MAX) {
          await writeSseFrame({
            event: "catchup-truncated",
            data: { kind: "catchup-truncated", replayed: replayRows.length },
          });
          // Do not flush live frames after a truncated page: the browser must
          // reconnect from the last replayed cursor before it can safely join
          // the live tail.
          teardown(true);
          return;
        }

        // Drain everything that arrived before the authoritative status read.
        // Persisted events still belong after the replay gap, while status
        // signals are snapshots rather than ordered events and are superseded
        // by the database read below. This prevents an older buffered
        // `running` signal from regressing a run that already became terminal.
        while (bufferedLiveFrames.length > 0 && !torn) {
          const buffered = bufferedLiveFrames.shift();
          if (!buffered) break;
          try {
            if (buffered.event.kind === "event") {
              await writeFrame(buffered.event);
            }
          } finally {
            pendingLiveBytes -= buffered.bytes;
          }
        }

        // The pre-subscription run row may be stale after catch-up and after
        // the buffered frames just drained. Re-read the tenant-scoped status,
        // then fold only publications that race with this query into it.
        const latestRun = await db
          .select({
            status: runs.status,
            outcomeStatus: runs.outcomeStatus,
            semanticViolationCount: runs.semanticViolationCount,
          })
          .from(runs)
          .where(and(eq(runs.id, runId), eq(runs.orgId, auth.orgId)));
        if (!latestRun[0] || torn) {
          teardown(true);
          return;
        }
        let effectiveStatus: PublishedRunEvent = {
          kind: "run.status",
          status: latestRun[0].status,
          ...(latestRun[0].outcomeStatus !== undefined
            ? { outcomeStatus: latestRun[0].outcomeStatus }
            : {}),
          ...(latestRun[0].semanticViolationCount !== undefined
            ? {
                semanticViolationCount:
                  latestRun[0].semanticViolationCount,
              }
            : {}),
        };
        while (bufferedLiveFrames.length > 0 && !torn) {
          const buffered = bufferedLiveFrames.shift();
          if (!buffered) break;
          if (buffered.event.kind === "run.status") {
            effectiveStatus = {
              ...effectiveStatus,
              ...buffered.event,
            };
            pendingLiveBytes -= buffered.bytes;
          } else {
            try {
              await writeFrame(buffered.event);
            } finally {
              pendingLiveBytes -= buffered.bytes;
            }
          }
        }
        await writeFrame(effectiveStatus);

        // A slow socket can yield while the snapshot is written. Drain any
        // publications that arrived in that interval before switching the hub
        // callback to its serialized steady-state delivery queue.
        while (bufferedLiveFrames.length > 0 && !torn) {
          const buffered = bufferedLiveFrames.shift();
          if (!buffered) break;
          try {
            await writeFrame(buffered.event);
          } finally {
            pendingLiveBytes -= buffered.bytes;
          }
        }
        catchingUp = false;
      } catch {
        // Headers may already be committed. Never bubble into the JSON error
        // dispatcher; close the SSE response and release every stream resource.
        teardown(true);
      }
    } },
];
