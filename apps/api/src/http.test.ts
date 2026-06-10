import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type http from "node:http";

import { readJson } from "./http";

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
