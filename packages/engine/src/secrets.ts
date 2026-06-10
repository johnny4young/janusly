/**
 * Secret value resolution + reference scanning. `{{secret.NAME}}` template
 * strings resolve to `process.env.NAME` at run time; the resolved values
 * never reach persistence — `template.ts:renderTemplateWithRedactions`
 * tracks which values to strip and `execute-node.ts` applies the redaction
 * before the executor's output lands in `run_nodes.state_json`.
 *
 * Used by `template.ts` (the template renderer is the only resolver call
 * site) and by `apps/api/src/routes/credentials-routes.ts`
 * `POST /credentials` validation (`listSecretRefs`).
 *
 * Invariants:
 * - The persist-side guarantee — never write resolved secret values to the
 *   DB — is enforced in `execute-node.ts` via `redactValues`. Don't bypass.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const RESUME_TOKEN_VERSION = "v1";
const DEV_RESUME_TOKEN_SECRET = "janusly-dev-resume-token-secret";

/**
 * How long a signed resume token stays valid. A paused `human_form` is a
 * long-lived state — an operator may not return to it immediately — but
 * leaving the token valid forever turns a leaked URL (forwarded email,
 * support ticket, browser history) into an indefinite cross-time replay
 * surface. Seven days lines up with "left over a long weekend" without
 * giving a stale link an indefinite shelf life.
 */
const RESUME_TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Resolve a `{{secret.NAME}}` reference to `process.env.NAME`; throws when missing. */
export function getSecret(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing secret: ${name}`);
  }

  return value;
}

/** Collect the unique set of `{{secret.NAME}}` reference names found anywhere in `value`. */
export function listSecretRefs(value: any): string[] {
  const refs = new Set<string>();

  function visit(input: any) {
    if (typeof input === "string") {
      for (const match of input.matchAll(/{{\s*secret\.([A-Z0-9_]+)\s*}}/gi)) {
        refs.add(match[1]);
      }
      return;
    }

    if (Array.isArray(input)) {
      input.forEach(visit);
      return;
    }

    if (typeof input === "object" && input !== null) {
      Object.values(input).forEach(visit);
    }
  }

  visit(value);
  return Array.from(refs);
}

export type ResumeTokenPurpose = "human_form";

export type ResumeTokenPayload = {
  /** Org binding — a token signed for org A cannot resume an org B run, even if runId/nodeId match. */
  orgId: string;
  runId: string;
  nodeId: string;
  purpose: ResumeTokenPurpose;
  /** Unix seconds. Used against `RESUME_TOKEN_TTL_SECONDS` for expiry. */
  issuedAt: number;
};

/** Create a signed token for resume surfaces that carry user-submitted data. */
export function signResumeToken(input: Omit<ResumeTokenPayload, "issuedAt">): string {
  const payload: ResumeTokenPayload = {
    ...input,
    issuedAt: Math.floor(Date.now() / 1000),
  };
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);
  return `${RESUME_TOKEN_VERSION}.${encodedPayload}.${signature}`;
}

/**
 * Verify a signed resume token against the expected `(orgId, runId, nodeId,
 * purpose)` triple and the TTL. Returns the parsed payload on success;
 * throws "Invalid resume token" on any failure (bad signature, wrong
 * binding, expired). The error message is deliberately uniform so a
 * caller can map it to a single 403 without leaking which constraint
 * was violated.
 */
export function verifyResumeToken(
  token: string,
  expected: Omit<ResumeTokenPayload, "issuedAt">,
): ResumeTokenPayload {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== RESUME_TOKEN_VERSION) {
    throw new Error("Invalid resume token");
  }

  const [, encodedPayload, signature] = parts;
  const expectedSignature = signPayload(encodedPayload);
  if (!safeEqual(signature, expectedSignature)) {
    throw new Error("Invalid resume token");
  }

  let payload: ResumeTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload)) as ResumeTokenPayload;
  } catch {
    throw new Error("Invalid resume token");
  }

  if (
    payload.orgId !== expected.orgId ||
    payload.runId !== expected.runId ||
    payload.nodeId !== expected.nodeId ||
    payload.purpose !== expected.purpose ||
    typeof payload.issuedAt !== "number"
  ) {
    throw new Error("Invalid resume token");
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (nowSeconds - payload.issuedAt > RESUME_TOKEN_TTL_SECONDS) {
    throw new Error("Invalid resume token");
  }

  return payload;
}

/**
 * Generic signed-payload primitive built on the same HMAC chokepoint as
 * `signResumeToken`. Used for purposes other than human-form resume —
 * notably SSO state tokens (10-min TTL, bound to org + nonce + callback
 * URL) and SSO session tokens (8-hour TTL, bound to org + user + email).
 *
 * The `purpose` discriminator is part of the signed envelope: an SSO
 * session token cannot be replayed as a human-form resume token (and
 * vice versa) even when both share `JANUSLY_RESUME_TOKEN_SECRET`. The
 * underlying HMAC + base64url encoding is identical to the resume-token
 * format, but the verifier requires the expected `purpose` to match
 * exactly.
 *
 * Errors are uniform "Invalid signed token" so callers can map any
 * failure to a single 401/400 without leaking which constraint failed.
 */
export type SignedTokenEnvelope<P extends string, T> = {
  purpose: P;
  payload: T;
  /** Unix seconds. */
  issuedAt: number;
  /** Unix seconds. Expiry is checked against `issuedAt + ttlSeconds <= now`. */
  expiresAt: number;
};

export function signSignedToken<P extends string, T>(input: {
  purpose: P;
  payload: T;
  ttlSeconds: number;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const envelope: SignedTokenEnvelope<P, T> = {
    purpose: input.purpose,
    payload: input.payload,
    issuedAt: now,
    expiresAt: now + input.ttlSeconds,
  };
  const encoded = base64UrlEncode(JSON.stringify(envelope));
  const signature = signPayload(encoded);
  return `${RESUME_TOKEN_VERSION}.${encoded}.${signature}`;
}

export function verifySignedToken<P extends string, T>(
  token: string,
  expectedPurpose: P,
): SignedTokenEnvelope<P, T> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== RESUME_TOKEN_VERSION) {
    throw new Error("Invalid signed token");
  }

  const [, encodedPayload, signature] = parts;
  const expectedSignature = signPayload(encodedPayload);
  if (!safeEqual(signature, expectedSignature)) {
    throw new Error("Invalid signed token");
  }

  let envelope: SignedTokenEnvelope<P, T>;
  try {
    envelope = JSON.parse(base64UrlDecode(encodedPayload)) as SignedTokenEnvelope<P, T>;
  } catch {
    throw new Error("Invalid signed token");
  }

  if (
    envelope.purpose !== expectedPurpose ||
    typeof envelope.issuedAt !== "number" ||
    typeof envelope.expiresAt !== "number"
  ) {
    throw new Error("Invalid signed token");
  }

  if (Math.floor(Date.now() / 1000) >= envelope.expiresAt) {
    throw new Error("Invalid signed token");
  }

  return envelope;
}

function signPayload(encodedPayload: string): string {
  return createHmac("sha256", getResumeTokenSecret())
    .update(`${RESUME_TOKEN_VERSION}.${encodedPayload}`)
    .digest("base64url");
}

function getResumeTokenSecret(): string {
  // Dedicated secret only — never reuse the API service bearer token
  // (`JANUSLY_API_SERVICE_TOKEN`). The two are rotated on different
  // schedules and visible in different log surfaces; sharing them
  // would let anyone with bearer-token-leakage visibility forge resume
  // tokens, and would force every outstanding form link to invalidate
  // every time the service token rotates.
  const configured = process.env.JANUSLY_RESUME_TOKEN_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("JANUSLY_RESUME_TOKEN_SECRET is required in production");
  }
  return DEV_RESUME_TOKEN_SECRET;
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): string {
  return Buffer.from(value, "base64url").toString("utf8");
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
