import { httpError } from "./http";

type Bucket = { count: number; resetAt: number };

const windows = new Map<string, Map<string, Bucket>>();

export type RateLimitOptions = {
  name: string;
  windowMs: number;
  max: number;
};

export function enforceRateLimit(key: string, options: RateLimitOptions) {
  let scope = windows.get(options.name);
  if (!scope) {
    scope = new Map();
    windows.set(options.name, scope);
  }

  const now = Date.now();
  const bucket = scope.get(key);

  if (!bucket || bucket.resetAt <= now) {
    scope.set(key, { count: 1, resetAt: now + options.windowMs });
    return;
  }

  if (bucket.count >= options.max) {
    const retryAfterSec = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    throw httpError(
      `Rate limit exceeded for ${options.name}. Retry in ${retryAfterSec}s.`,
      429,
    );
  }

  bucket.count++;
}

export function resetRateLimits() {
  windows.clear();
}
