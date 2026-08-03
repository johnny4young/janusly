import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeOrigin,
  parseWorkPlaneMetric,
  readBoundedText,
} from "./collect-runtime-proof.mjs";

test("runtime proof origins allow only credential-free HTTP origins", () => {
  assert.equal(normalizeOrigin("https://ops.example.test:8443", "origin"), "https://ops.example.test:8443");
  assert.equal(normalizeOrigin("http://127.0.0.1:4601/", "origin"), "http://127.0.0.1:4601");
  for (const value of [
    "file:///tmp/build",
    "https://user:secret@example.test",
    "https://example.test/build",
    "https://example.test?token=x",
  ]) {
    assert.throws(() => normalizeOrigin(value, "origin"), /HTTP\(S\) origin/u, value);
  }
});

test("runtime proof reads exactly one binary work-plane gauge", () => {
  assert.equal(parseWorkPlaneMetric(`# HELP janusly_go_work_plane_active owner\n# TYPE janusly_go_work_plane_active gauge\njanusly_go_work_plane_active 1\n`), 1);
  assert.equal(parseWorkPlaneMetric("janusly_go_work_plane_active 0\n"), 0);
  assert.throws(() => parseWorkPlaneMetric("go_goroutines 10\n"), /found 0/u);
  assert.throws(() => parseWorkPlaneMetric(
    "janusly_go_work_plane_active 0\njanusly_go_work_plane_active 1\n"), /found 2/u);
});

test("runtime proof bounds every downloaded evidence body", async () => {
  assert.equal(await readBoundedText(new Response("proof"), "https://example.test/build", 5), "proof");
  await assert.rejects(
    readBoundedText(new Response("too large"), "https://example.test/build", 4),
    /response exceeds 4 bytes/u,
  );
  await assert.rejects(
    readBoundedText(new Response("small", { headers: { "content-length": "99" } }),
      "https://example.test/build", 5),
    /response exceeds 5 bytes/u,
  );
});
