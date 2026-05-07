/**
 * The implementation lives in `@janusly/shared`. The full behavioural
 * test suite lives next to it (`packages/shared/src/error-signature.test.ts`).
 * This file pins the back-compat invariant: importing from the engine
 * subpath returns the same function references as importing from the
 * shared subpath, so consumers using either import path get identical
 * behaviour.
 */
import { describe, expect, it } from "vitest";
import * as fromEngine from "./error-signature";
import * as fromShared from "@janusly/shared/src/error-signature";

describe("error-signature back-compat — engine re-export", () => {
  it("normalizeErrorSignature is referentially equal across import paths", () => {
    expect(fromEngine.normalizeErrorSignature).toBe(fromShared.normalizeErrorSignature);
  });

  it("scrubSecretShapes is referentially equal across import paths", () => {
    expect(fromEngine.scrubSecretShapes).toBe(fromShared.scrubSecretShapes);
  });

  it("FALLBACK_SIGNATURE_MAX_LENGTH is referentially equal across import paths", () => {
    expect(fromEngine.FALLBACK_SIGNATURE_MAX_LENGTH).toBe(fromShared.FALLBACK_SIGNATURE_MAX_LENGTH);
  });

  it("SECRET_VALUE_PATTERNS is referentially equal across import paths", () => {
    expect(fromEngine.SECRET_VALUE_PATTERNS).toBe(fromShared.SECRET_VALUE_PATTERNS);
  });
});
