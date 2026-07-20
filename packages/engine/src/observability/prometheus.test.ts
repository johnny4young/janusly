import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import {
  API_METRICS_DEFAULT_PORT,
  METRICS_DEFAULT_HOST,
  resolveMetricsHost,
  resolveMetricsPort,
  startPrometheusMetrics,
  WORKER_METRICS_DEFAULT_PORT,
} from "./prometheus";

const priorHost = process.env.OTEL_METRICS_HOST;
const priorPort = process.env.OTEL_METRICS_PORT;

afterEach(() => {
  if (priorHost === undefined) delete process.env.OTEL_METRICS_HOST;
  else process.env.OTEL_METRICS_HOST = priorHost;
  if (priorPort === undefined) delete process.env.OTEL_METRICS_PORT;
  else process.env.OTEL_METRICS_PORT = priorPort;
});

describe("resolveMetricsPort", () => {
  it("keeps process defaults distinct and accepts a valid override", () => {
    expect(API_METRICS_DEFAULT_PORT).not.toBe(WORKER_METRICS_DEFAULT_PORT);
    expect(resolveMetricsPort(undefined, API_METRICS_DEFAULT_PORT)).toBe(9464);
    expect(resolveMetricsPort("10555", API_METRICS_DEFAULT_PORT)).toBe(10_555);
  });

  it("falls back for malformed or out-of-range ports", () => {
    expect(resolveMetricsPort("NaN", 9464)).toBe(9464);
    expect(resolveMetricsPort("0", 9464)).toBe(9464);
    expect(resolveMetricsPort("65536", 9464)).toBe(9464);
    expect(resolveMetricsPort("9464.5", 9464)).toBe(9464);
  });
});

describe("metrics listener", () => {
  it("defaults to loopback and accepts an explicit scrape host", () => {
    expect(resolveMetricsHost(undefined)).toBe(METRICS_DEFAULT_HOST);
    expect(resolveMetricsHost("  ")).toBe("127.0.0.1");
    expect(resolveMetricsHost("0.0.0.0")).toBe("0.0.0.0");
  });

  it("rejects startup when the configured port cannot bind", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("test port unavailable");
    process.env.OTEL_METRICS_HOST = "127.0.0.1";
    process.env.OTEL_METRICS_PORT = String(address.port);

    try {
      await expect(startPrometheusMetrics({
        defaultPort: API_METRICS_DEFAULT_PORT,
        processName: "api",
      })).rejects.toThrow(/failed to bind/);
    } finally {
      await new Promise<void>((resolve, reject) => blocker.close((error) => {
        if (error) reject(error);
        else resolve();
      }));
    }
  });
});
