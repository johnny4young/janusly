/** Static safety classification for shared registered-tool dispatch. */

import { describe, expect, it } from "vitest";
import { isToolInvocationWriteSide } from "./tool-execution";

describe("isToolInvocationWriteSide", () => {
  it("distinguishes explicit read and write HTTP methods", () => {
    expect(isToolInvocationWriteSide("http.request", { url: "https://example.com" })).toBe(false);
    expect(isToolInvocationWriteSide("http.request", { url: "https://example.com", method: "GET" })).toBe(false);
    expect(isToolInvocationWriteSide("http.request", { url: "https://example.com", method: "POST" })).toBe(true);
  });

  it("fails safe for whole-object and malformed dynamic HTTP inputs", () => {
    expect(isToolInvocationWriteSide("http.request", "{{item}}")).toBe(true);
    expect(isToolInvocationWriteSide("http.request", { method: "{{item.method}}" })).toBe(true);
    expect(isToolInvocationWriteSide("http.request", { method: 1 })).toBe(true);
  });

  it("uses the registry flag for non-HTTP tools", () => {
    expect(isToolInvocationWriteSide("email.send", {})).toBe(true);
    expect(isToolInvocationWriteSide("json.parse", {})).toBe(false);
  });
});
