import { z } from "zod";

export const VALIDATION_EVIDENCE_LEVELS = [
  "static",
  "writes_skipped",
  "provider_simulated",
  "live_canary",
] as const;

export const ValidationEvidenceLevelSchema = z.enum(
  VALIDATION_EVIDENCE_LEVELS,
);

export type ValidationEvidenceLevel = z.infer<
  typeof ValidationEvidenceLevelSchema
>;

/** Only evidence that exercised the external-effect boundary may act alone. */
export function supportsAutonomousRecovery(
  level: ValidationEvidenceLevel | null | undefined,
): boolean {
  return level === "provider_simulated" || level === "live_canary";
}

export function parseValidationEvidenceLevel(
  value: unknown,
): ValidationEvidenceLevel {
  const parsed = ValidationEvidenceLevelSchema.safeParse(value);
  return parsed.success ? parsed.data : "static";
}
