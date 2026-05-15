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
