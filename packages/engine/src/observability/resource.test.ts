import { afterEach, describe, expect, it, vi } from "vitest";

describe("janusResource", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("declares service.name = 'janusly' and service.namespace = 'janusly'", async () => {
    vi.resetModules();
    const { janusResource } = await import("./resource");
    expect(janusResource.attributes["service.name"]).toBe("janusly");
    expect(janusResource.attributes["service.namespace"]).toBe("janusly");
  });

  it("uses OTEL_SERVICE_INSTANCE_ID when set", async () => {
    vi.stubEnv("OTEL_SERVICE_INSTANCE_ID", "k8s-pod-7d5c");
    vi.resetModules();
    const { janusResource } = await import("./resource");
    expect(janusResource.attributes["service.instance.id"]).toBe("k8s-pod-7d5c");
  });

  it("falls back to HOSTNAME when OTEL_SERVICE_INSTANCE_ID is unset", async () => {
    vi.stubEnv("OTEL_SERVICE_INSTANCE_ID", "");
    vi.stubEnv("HOSTNAME", "compose-worker-1");
    vi.resetModules();
    const { janusResource } = await import("./resource");
    expect(janusResource.attributes["service.instance.id"]).toBe("compose-worker-1");
  });

  it("always produces a non-empty service.instance.id", async () => {
    vi.stubEnv("OTEL_SERVICE_INSTANCE_ID", "");
    vi.stubEnv("HOSTNAME", "");
    vi.resetModules();
    const { janusResource } = await import("./resource");
    const id = janusResource.attributes["service.instance.id"];
    expect(typeof id).toBe("string");
    expect((id as string).length).toBeGreaterThan(0);
  });
});
