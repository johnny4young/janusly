import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type http from "node:http";
import { z } from "zod";

import { readJson, sendJson, type CorsAwareResponse } from "./http";

/** Build a fake `IncomingMessage` that emits the given Buffer chunks. `readJson` only consumes the stream surface (`data`/`error`/`end` + `destroy`), which `Readable` provides. */
function fakeRequest(chunks: Buffer[]): http.IncomingMessage {
  const readable = new Readable({
    read() {
      for (const chunk of chunks) this.push(chunk);
      this.push(null);
    },
  });
  return readable as unknown as http.IncomingMessage;
}

describe("readJson", () => {
  it("decodes a multi-byte UTF-8 character split across chunk boundaries", async () => {
    // "España" — the ñ is 2 bytes (0xC3 0xB1). Split the body exactly between
    // them: per-chunk decoding would turn each half into U+FFFD, which is
    // VALID inside a JSON string, so the corruption would parse fine and
    // persist silently. The single-shot Buffer.concat decode keeps the ñ.
    const body = Buffer.from('{"name":"España"}', "utf8");
    const splitAt = body.indexOf(0xb1); // second byte of ñ
    expect(body[splitAt - 1]).toBe(0xc3); // sanity: we really split inside the char

    const parsed = await readJson(fakeRequest([body.subarray(0, splitAt), body.subarray(splitAt)]), 1024);

    expect(parsed).toEqual({ name: "España" });
  });

  it("rejects 413 when the body exceeds maxBytes", async () => {
    const big = Buffer.from(`{"pad":"${"x".repeat(64)}"}`, "utf8");

    await expect(readJson(fakeRequest([big]), 16)).rejects.toMatchObject({ statusCode: 413 });
  });

  it("rejects 400 on a malformed JSON body", async () => {
    await expect(readJson(fakeRequest([Buffer.from("{not json", "utf8")]), 1024)).rejects.toMatchObject({
      statusCode: 400,
    });
  });

  it("resolves {} for an empty body", async () => {
    await expect(readJson(fakeRequest([]), 1024)).resolves.toEqual({});
  });

  it("memoizes the parsed body for contract validation and handler reuse", async () => {
    const request = fakeRequest([Buffer.from('{"runId":"run-1"}', "utf8")]);

    const first = readJson(request, 1024);
    const second = readJson(request, 1024);

    await expect(first).resolves.toEqual({ runId: "run-1" });
    await expect(second).resolves.toEqual({ runId: "run-1" });
  });

  it("tolerates string chunks (encoding-set streams and test doubles)", async () => {
    // Production IncomingMessage streams emit Buffers, but a stream with an
    // encoding set — or a hand-rolled test double — emits strings. readJson
    // must normalize instead of letting Buffer.concat throw inside a stream
    // callback, which would leave the promise unsettled forever.
    const readable = new Readable({ encoding: "utf8", read() {} });
    readable.push(Buffer.from('{"ok":', "utf8"));
    readable.push(Buffer.from("true}", "utf8"));
    readable.push(null);

    await expect(readJson(readable as unknown as http.IncomingMessage, 1024)).resolves.toEqual({ ok: true });
  });
});

/** Capture what `sendJson` wrote to a response, carrying the request context it reads. */
function fakeResponse(opts: { acceptEncoding?: string; origin?: string } = {}) {
  const captured: { status?: number; headers?: http.OutgoingHttpHeaders; body?: unknown } = {};
  const res = {
    requestAcceptEncoding: opts.acceptEncoding,
    requestOrigin: opts.origin,
    writeHead(status: number, headers: http.OutgoingHttpHeaders) {
      captured.status = status;
      captured.headers = headers;
      return this;
    },
    end(body?: unknown) {
      captured.body = body;
      return this;
    },
  };
  return { res: res as unknown as CorsAwareResponse, captured };
}

/** A payload whose serialized form comfortably clears the 1 KB gzip threshold. */
function largePayload() {
  return { note: "x".repeat(4096), items: Array.from({ length: 20 }, (_, i) => ({ i, label: `row-${i}` })) };
}

describe("sendJson gzip", () => {
  const priorFlag = process.env.JANUSLY_HTTP_COMPRESSION;
  afterEach(() => {
    if (priorFlag === undefined) delete process.env.JANUSLY_HTTP_COMPRESSION;
    else process.env.JANUSLY_HTTP_COMPRESSION = priorFlag;
  });

  it("gzips a large body when the client accepts gzip and round-trips identically", () => {
    const payload = largePayload();
    const { res, captured } = fakeResponse({ acceptEncoding: "gzip, deflate, br" });

    sendJson(res, payload);

    expect(captured.headers?.["Content-Encoding"]).toBe("gzip");
    expect(Buffer.isBuffer(captured.body)).toBe(true);
    const decoded = JSON.parse(gunzipSync(captured.body as Buffer).toString("utf8"));
    expect(decoded).toEqual(payload);
  });

  it("preserves the CORS Vary: Origin alongside Accept-Encoding when compressing", () => {
    const { res, captured } = fakeResponse({ acceptEncoding: "gzip", origin: "http://localhost:5173" });

    sendJson(res, largePayload());

    const vary = String(captured.headers?.["Vary"] ?? "");
    expect(vary).toContain("Origin");
    expect(vary).toContain("Accept-Encoding");
  });

  it("leaves a small body uncompressed even when gzip is accepted", () => {
    const { res, captured } = fakeResponse({ acceptEncoding: "gzip" });

    sendJson(res, { ok: true });

    expect(captured.headers?.["Content-Encoding"]).toBeUndefined();
    expect(typeof captured.body).toBe("string");
    expect(JSON.parse(captured.body as string)).toEqual({ ok: true });
  });

  it("does not compress when the client did not advertise gzip", () => {
    const { res, captured } = fakeResponse({ acceptEncoding: "br, deflate" });

    sendJson(res, largePayload());

    expect(captured.headers?.["Content-Encoding"]).toBeUndefined();
    expect(typeof captured.body).toBe("string");
  });

  it("treats gzip;q=0 as an explicit refusal", () => {
    const { res, captured } = fakeResponse({ acceptEncoding: "gzip;q=0, identity" });

    sendJson(res, largePayload());

    expect(captured.headers?.["Content-Encoding"]).toBeUndefined();
  });

  it("honors the JANUSLY_HTTP_COMPRESSION=false kill-switch", () => {
    process.env.JANUSLY_HTTP_COMPRESSION = "false";
    const { res, captured } = fakeResponse({ acceptEncoding: "gzip" });

    sendJson(res, largePayload());

    expect(captured.headers?.["Content-Encoding"]).toBeUndefined();
    expect(typeof captured.body).toBe("string");
  });
});

describe("sendJson v1 errors", () => {
  it("preserves a catalogued budget code and scalar context", () => {
    const { res, captured } = fakeResponse();
    res.apiVersion = "v1";
    res.requestId = "request-budget";
    res.contract = {
      operationId: "budgetProbe",
      path: "/budget-probe",
      summary: "Probe budget errors",
      tags: ["Test"],
      response: z.object({ ok: z.literal(true) }),
      errorCodes: ["budget_exceeded"],
    };

    sendJson(res, {
      error: "budget_exceeded",
      code: "budget_exceeded",
      params: { monthlyUsdSpent: 12, monthlyUsdLimit: 10, resolvedScope: "org" },
      budget: { allowed: false },
    }, 402);

    expect(captured.status).toBe(402);
    expect(JSON.parse(captured.body as string)).toEqual({
      apiVersion: "v1",
      requestId: "request-budget",
      error: {
        code: "budget_exceeded",
        message: "budget_exceeded",
        params: { monthlyUsdSpent: 12, monthlyUsdLimit: 10, resolvedScope: "org" },
      },
    });
  });
});
