import type { RetryPolicy, SerializedError } from "./types";

const HTTP_STATUS_PATTERN = /^(\d)xx$/;

export function classifyError(error: SerializedError): string[] {
  const labels = new Set<string>();

  if (error.name) labels.add(error.name);
  if (error.code) labels.add(error.code);

  const statusCode = error.statusCode;
  if (typeof statusCode === "number") {
    labels.add(String(statusCode));
    labels.add(`${Math.floor(statusCode / 100)}xx`);
  }

  const message = error.message.toLowerCase();
  if (message.includes("timeout") || error.code === "ETIMEDOUT") labels.add("timeout");
  if (message.includes("network") || error.code === "ECONNRESET" || error.code === "ENOTFOUND") labels.add("network");

  return [...labels];
}

function matchesPattern(label: string, pattern: string): boolean {
  if (label === pattern) return true;

  const match = pattern.match(HTTP_STATUS_PATTERN);
  if (!match) return false;

  return label.startsWith(match[1]) && label.length === 3;
}

export function shouldRetry(error: SerializedError, policy?: RetryPolicy): boolean {
  if (!policy) return false;

  const labels = classifyError(error);

  if (policy.ignoreOn?.some((pattern) => labels.some((label) => matchesPattern(label, pattern)))) {
    return false;
  }

  if (!policy.retryOn || policy.retryOn.length === 0) {
    return true;
  }

  return policy.retryOn.some((pattern) => labels.some((label) => matchesPattern(label, pattern)));
}

export function computeRetryDelay(attempt: number, policy?: RetryPolicy): number {
  if (!policy) return 0;

  const base = policy.delayMs ?? 1000;
  const rawDelay = policy.backoff === "exponential"
    ? base * Math.pow(2, attempt - 1)
    : base;

  const cappedDelay = typeof policy.maxDelayMs === "number"
    ? Math.min(rawDelay, policy.maxDelayMs)
    : rawDelay;

  if (!policy.jitter) return cappedDelay;

  const min = Math.floor(cappedDelay * 0.5);
  const max = cappedDelay;
  return Math.floor(min + Math.random() * (max - min));
}
