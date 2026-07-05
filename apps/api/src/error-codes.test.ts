/**
 * Tests for the closed API error code catalog + the canonical envelope
 * builder. Catches accidental envelope-shape drift before it lands in
 * the wire contract the web's `tApiError` reads.
 */
import { describe, expect, it } from "vitest";

import { errorEnvelope, type ApiErrorCode, type ApiErrorEnvelope } from "./error-codes";

describe("errorEnvelope", () => {
  it("returns { error, code } without params when params are absent", () => {
    const env = errorEnvelope("member_not_found", "Member not found");
    expect(env).toEqual({ error: "Member not found", code: "member_not_found" });
    expect("params" in env).toBe(false);
  });

  it("attaches params when supplied (for i18next interpolation)", () => {
    const env = errorEnvelope("member_exists", "Member already exists for this org", {
      email: "ada@example.com",
    });
    expect(env).toEqual({
      error: "Member already exists for this org",
      code: "member_exists",
      params: { email: "ada@example.com" },
    });
  });

  it("interpolates {{key}} placeholders in the EN fallback from params", () => {
    const env = errorEnvelope("reports_unknown_format", 'Unknown format: {{format}}. Use "markdown" or "json".', {
      format: "xml",
    });
    expect(env.error).toBe('Unknown format: xml. Use "markdown" or "json".');
    // params still travel for the web's localized catalog.
    expect(env.params).toEqual({ format: "xml" });
  });

  it("interpolates multiple placeholders and tolerates inner whitespace", () => {
    const env = errorEnvelope("recovery_evidence_invalid_body", "Invalid request: {{ path }}: {{message}}", {
      path: "body.email",
      message: "required",
    });
    expect(env.error).toBe("Invalid request: body.email: required");
  });

  it("stringifies number / boolean params during interpolation", () => {
    const env = errorEnvelope("dlq_ids_cap_exceeded", "deadLetterIds exceeds the per-request cap of {{cap}}", {
      cap: 100,
    });
    expect(env.error).toBe("deadLetterIds exceeds the per-request cap of 100");
  });

  it("leaves an unmatched placeholder untouched (no matching param key)", () => {
    const env = errorEnvelope("reports_unknown_format", "Unknown {{format}} and {{other}}", { format: "xml" });
    expect(env.error).toBe("Unknown xml and {{other}}");
  });

  it("leaves a literal message without placeholders unchanged", () => {
    const env = errorEnvelope("member_exists", "Member already exists for this org", {
      email: "ada@example.com",
    });
    expect(env.error).toBe("Member already exists for this org");
  });

  it("accepts string | number | boolean params via type-system check", () => {
    // Compile-time guard — if the union widens, this test still passes;
    // we just want a runtime example of every primitive shape.
    const env = errorEnvelope("dlq_field_required", "deadLetterId is required", {
      field: "deadLetterId",
      attempt: 3,
      retry: true,
    });
    expect(env.params).toEqual({ field: "deadLetterId", attempt: 3, retry: true });
  });

  it("preserves the closed-union shape on the returned envelope", () => {
    const env: ApiErrorEnvelope = errorEnvelope("role_in_use", "Role still has members", {
      membersAffected: 2,
    });
    // Narrow check on a closed-set value — TypeScript would flag a bad code here.
    const codes: ApiErrorCode[] = [
      "email_required",
      "email_invalid",
      "invitation_pending_exists",
      "member_exists",
      "member_not_found",
      "role_in_use",
      "role_already_exists",
      "role_not_found",
      "mcp_connection_not_found",
      "mcp_tool_not_found",
      "mcp_connection_duplicate",
      "dlq_not_found",
      "dlq_field_required",
      "workflow_not_found",
      "workflow_name_required",
    ];
    expect(codes).toContain(env.code);
  });
});
