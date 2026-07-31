import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We mock the AI SDK's `generateText` so the tests never make a real network
// call; the registry-based bindings still build real provider clients but
// they're handed our spy via the mock. This lets us assert exactly what
// arguments the abstraction passes through to the underlying SDK.
//
// `vi.mock` is hoisted to the top of the file, so any variables it captures
// must be declared via `vi.hoisted()` to share the same hoist phase.
const { generateTextMock, outputObjectMock, wrapLanguageModelMock, defaultSettingsMiddlewareMock } = vi.hoisted(
  () => ({
    generateTextMock: vi.fn(),
    // Stub Output.object so tests can pass arbitrary schema sentinels without
    // building real Zod schemas. The mocked `generateText` ignores the
    // returned spec anyway — it just needs to type-check.
    outputObjectMock: vi.fn((opts) => ({ __mockOutputSpec: true, ...opts })),
    // Sentinel-returning stubs so tests can pin the JSON-mode model wrap
    // (which model got wrapped, with which middleware settings) without
    // exercising real SDK middleware machinery.
    wrapLanguageModelMock: vi.fn(({ model, middleware }) => ({ __wrappedModel: true, model, middleware })),
    defaultSettingsMiddlewareMock: vi.fn((opts) => ({ __mockMiddleware: true, ...opts })),
  }),
);
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: generateTextMock,
    wrapLanguageModel: wrapLanguageModelMock,
    defaultSettingsMiddleware: defaultSettingsMiddlewareMock,
    Output: { ...actual.Output, object: outputObjectMock },
  };
});

import {
  _registerProviderForTests,
  _resetLlmClientForTests,
  _unregisterProviderForTests,
  createLlmClient,
  getLlmClient,
  resolveLlmConfig,
  type ProviderSpec,
} from "./llm-client";
import {
  _resetUsageRecorderForTests,
  setUsageRecorder,
  type UsageRecord,
} from "./usage-recorder";

const baseUsage = { inputTokens: 10, outputTokens: 20 };

afterEach(() => {
  generateTextMock.mockReset();
  // mockClear (not mockReset) — these two keep their sentinel implementations.
  wrapLanguageModelMock.mockClear();
  defaultSettingsMiddlewareMock.mockClear();
  _resetLlmClientForTests();
});

describe("resolveLlmConfig", () => {
  it("returns null when no key is configured for the default provider", () => {
    expect(resolveLlmConfig({} as NodeJS.ProcessEnv)).toBeNull();
  });

  it("defaults to anthropic when JANUSLY_LLM_PROVIDER is unset (the supported posture)", () => {
    const cfg = resolveLlmConfig({ ANTHROPIC_API_KEY: "sk-ant-x" } as NodeJS.ProcessEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe("anthropic");
    expect(cfg!.apiKeys).toEqual({ anthropic: "sk-ant-x" });
    expect(cfg!.defaultModels.anthropic).toBe("claude-haiku-4-5-20251001");
  });

  it("picks anthropic when JANUSLY_LLM_PROVIDER=anthropic and the key is set", () => {
    const cfg = resolveLlmConfig({
      JANUSLY_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv);
    expect(cfg!.provider).toBe("anthropic");
    expect(cfg!.apiKeys).toEqual({ anthropic: "sk-ant-x" });
    expect(cfg!.defaultModels.anthropic).toBe("claude-haiku-4-5-20251001");
  });

  it("exposes both keys when both are set so per-call overrides work", () => {
    const cfg = resolveLlmConfig({
      OPENAI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv);
    expect(cfg!.apiKeys).toEqual({ openai: "sk-x", anthropic: "sk-ant-x" });
  });

  it("returns a config when only a non-default provider key is set so explicit overrides can work", () => {
    // Only the OpenAI key, no provider env: the DEFAULT resolves to anthropic
    // (no key — un-overridden calls degrade through the fallback contract),
    // but the config still carries the openai key so explicit
    // `openai/<model>` overrides keep working.
    const cfg = resolveLlmConfig({
      OPENAI_API_KEY: "sk-x",
    } as NodeJS.ProcessEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.provider).toBe("anthropic");
    expect(cfg!.apiKeys).toEqual({ openai: "sk-x" });
  });

  it("respects env-overridden default models", () => {
    const cfg = resolveLlmConfig({
      OPENAI_API_KEY: "sk-x",
      OPENAI_MODEL: "gpt-4.1",
      ANTHROPIC_MODEL: "claude-sonnet-4-5",
    } as NodeJS.ProcessEnv);
    expect(cfg!.defaultModels.openai).toBe("gpt-4.1");
    expect(cfg!.defaultModels.anthropic).toBe("claude-sonnet-4-5");
  });

  it("defaults and overrides the hard output-token ceiling", () => {
    const defaults = resolveLlmConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv);
    const configured = resolveLlmConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
      JANUSLY_LLM_MAX_OUTPUT_UNITS: "2048",
    } as NodeJS.ProcessEnv);

    expect(defaults!.maxOutputTokens).toBe(4096);
    expect(configured!.maxOutputTokens).toBe(2048);
  });

  it("rejects malformed direct env output limits back to the safe default", () => {
    for (const value of ["NaN", "255", "16385", "2048.5"]) {
      const cfg = resolveLlmConfig({
        ANTHROPIC_API_KEY: "sk-ant-x",
        JANUSLY_LLM_MAX_OUTPUT_UNITS: value,
      } as NodeJS.ProcessEnv);
      expect(cfg!.maxOutputTokens).toBe(4096);
    }
  });

  it("preserves an explicit Anthropic-compatible proxy base URL", () => {
    const cfg = resolveLlmConfig({
      ANTHROPIC_API_KEY: "local-key",
      ANTHROPIC_BASE_URL: "http://provider-simulator:4010/v1/",
    } as NodeJS.ProcessEnv);

    expect(cfg!.baseURLs.anthropic).toBe(
      "http://provider-simulator:4010/v1",
    );
  });

  it("repairs the canonical Anthropic host when its version segment is absent", () => {
    const cfg = resolveLlmConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    } as NodeJS.ProcessEnv);

    expect(cfg!.baseURLs.anthropic).toBe(
      "https://api.anthropic.com/v1",
    );
  });

  it("accepts only known, deduplicated simulated provider names", () => {
    const cfg = resolveLlmConfig({
      ANTHROPIC_API_KEY: "local-key",
      JANUSLY_LOCAL_STACK: "true",
      JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "true",
      JANUSLY_LLM_SIMULATED_PROVIDERS:
        " anthropic,unknown,anthropic ",
    } as NodeJS.ProcessEnv);

    expect(cfg!.simulatedProviders).toEqual(["anthropic"]);
  });

  it("ignores simulated-provider declarations outside the explicit local stack", () => {
    const cfg = resolveLlmConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
      JANUSLY_LLM_SIMULATED_PROVIDERS: "anthropic",
    } as NodeJS.ProcessEnv);

    expect(cfg!.simulatedProviders).toEqual([]);
  });

  it("falls back to anthropic with a warning when JANUSLY_LLM_PROVIDER is unknown", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cfg = resolveLlmConfig({
      JANUSLY_LLM_PROVIDER: "bogus",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv);
    expect(cfg!.provider).toBe("anthropic");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown JANUSLY_LLM_PROVIDER=bogus"));
    warn.mockRestore();
  });

  it("returns null when JANUSLY_LLM_PROVIDER=openai but no key is set", () => {
    expect(
      resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("createLlmClient — happy paths", () => {
  beforeEach(() => {
    generateTextMock.mockResolvedValue({
      text: "hello world",
      finishReason: "stop",
      usage: baseUsage,
    });
  });

  it("calls the AI SDK with the configured openai default and returns its text", async () => {
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    const result = await client.generateText({ prompt: "hi" });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const opts = generateTextMock.mock.calls[0][0];
    expect(opts.model).toBeDefined();
    expect(opts.prompt).toBe("hi");
    expect(opts.maxRetries).toBe(2);
    expect(opts.maxOutputTokens).toBe(4096);
    expect(opts.abortSignal).toBeInstanceOf(AbortSignal);
    expect(result).toMatchObject({
      text: "hello world",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      provider: "openai",
      model: "gpt-4o-mini",
    });
    // latencyMs always reported; costUsd computed from the default
    // gpt-4o-mini price ($0.15/$0.60 per 1M) for (10,20) tokens.
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.costUsd).toBeCloseTo(10 * 0.15 / 1e6 + 20 * 0.6 / 1e6, 9);
    expect(result.providerSimulated).toBe(false);
  });

  it("labels provider-compatible simulations and never attributes cloud cost", async () => {
    const cfg = resolveLlmConfig({
      ANTHROPIC_API_KEY: "local-key",
      JANUSLY_LOCAL_STACK: "true",
      JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "true",
      JANUSLY_LLM_SIMULATED_PROVIDERS: "anthropic",
    } as NodeJS.ProcessEnv)!;
    const result = await createLlmClient(cfg).generateText({
      prompt: "hi",
    });

    expect(result.provider).toBe("anthropic");
    expect(result.providerSimulated).toBe(true);
    expect(result.costUsd).toBe(0);
  });

  it("wraps the openai model with spec-level JSON-mode middleware when responseFormat is 'json'", async () => {
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await client.generateText({ prompt: "hi", responseFormat: "json" });

    // The middleware must inject the SPEC-LEVEL responseFormat (what the
    // OpenAI model classes translate to the wire's json_object format) —
    // provider options are not consulted for JSON mode.
    expect(defaultSettingsMiddlewareMock).toHaveBeenCalledWith({
      settings: { responseFormat: { type: "json" } },
    });
    expect(wrapLanguageModelMock).toHaveBeenCalledTimes(1);
    const opts = generateTextMock.mock.calls[0][0];
    expect(opts.model).toMatchObject({ __wrappedModel: true });
    expect(opts.providerOptions).toBeUndefined();
  });

  it("does NOT wrap the openai model when responseFormat is absent", async () => {
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await client.generateText({ prompt: "hi" });

    expect(wrapLanguageModelMock).not.toHaveBeenCalled();
    const opts = generateTextMock.mock.calls[0][0];
    expect(opts.model).not.toMatchObject({ __wrappedModel: true });
  });

  it("does NOT add JSON-mode wiring for anthropic (relies on the prompt)", async () => {
    const cfg = resolveLlmConfig({
      JANUSLY_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await client.generateText({ prompt: "hi", responseFormat: "json" });

    expect(wrapLanguageModelMock).not.toHaveBeenCalled();
    const opts = generateTextMock.mock.calls[0][0];
    expect(opts.providerOptions).toBeUndefined();
  });

  it("uses a bare modelHint with the configured provider", async () => {
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    const result = await client.generateText({ prompt: "hi", modelHint: "gpt-4.1" });

    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4.1");
  });

  it("overrides BOTH provider and model when modelHint contains a slash", async () => {
    const cfg = resolveLlmConfig({
      OPENAI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    const result = await client.generateText({
      prompt: "hi",
      modelHint: "anthropic/claude-sonnet-4-5",
    });

    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-sonnet-4-5");
  });

  it("can run an explicit non-default provider override even when the default provider key is absent", async () => {
    const cfg = resolveLlmConfig({
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    const result = await client.generateText({
      prompt: "hi",
      modelHint: "anthropic/claude-haiku-4-5",
    });

    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("ignores `responseFormat: 'json'` mapping when overriding to a provider without applyJsonMode", async () => {
    const cfg = resolveLlmConfig({
      OPENAI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await client.generateText({
      prompt: "hi",
      responseFormat: "json",
      modelHint: "anthropic/claude-haiku-4-5",
    });

    expect(wrapLanguageModelMock).not.toHaveBeenCalled();
    const opts = generateTextMock.mock.calls[0][0];
    expect(opts.providerOptions).toBeUndefined();
  });
});

describe("createLlmClient — error paths feed the fallback contract", () => {
  it("throws a descriptive error when the spec targets a provider with no key", async () => {
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await expect(
      client.generateText({ prompt: "hi", modelHint: "anthropic/claude-x" }),
    ).rejects.toThrow(/anthropic.*not configured.*ANTHROPIC_API_KEY/);
  });

  it("throws through the fallback contract when the configured default provider has no key", async () => {
    // The misconfigured-deployment scenario: only the OpenAI key is set and
    // no provider env, so the default resolves to anthropic (the supported
    // posture) with no key — every un-overridden call fails LOUDLY with the
    // missing-key error instead of silently routing to another vendor.
    const cfg = resolveLlmConfig({ OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await expect(client.generateText({ prompt: "hi" })).rejects.toThrow(
      /anthropic.*not configured.*ANTHROPIC_API_KEY/,
    );
  });

  it("throws when the spec targets an unknown provider", async () => {
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await expect(client.generateText({ prompt: "hi", modelHint: "bogus/foo" })).rejects.toThrow(
      /unknown provider 'bogus'/,
    );
  });

  it("propagates AI SDK errors so the caller's try/catch can degrade", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("rate limit"));
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await expect(client.generateText({ prompt: "hi" })).rejects.toThrow(/rate limit/);
  });
});

describe("plug-and-play extensibility — adding a provider is one entry", () => {
  it("a fake provider registered via the test escape works end-to-end", async () => {
    let captured: { id: string } | null = null;
    const fakeSpec: ProviderSpec = {
      envApiKey: "FAKE_API_KEY",
      envModel: "FAKE_MODEL",
      defaultModel: "fake-default",
      create: (apiKey) => {
        // The factory captures the apiKey at create time, then returns a
        // model-builder that captures the modelId at call time. The "model"
        // it returns is just an opaque marker the AI SDK will pass through
        // to our mocked `generateText`.
        return (modelId) => {
          captured = { id: `${apiKey}::${modelId}` };
          return captured as unknown as Parameters<typeof generateTextMock>[0]["model"];
        };
      },
    };
    _registerProviderForTests("fake", fakeSpec);
    try {
      generateTextMock.mockResolvedValueOnce({ text: "fake-response", finishReason: "stop" });
      const cfg = resolveLlmConfig({
        JANUSLY_LLM_PROVIDER: "fake",
        FAKE_API_KEY: "fake-key",
      } as NodeJS.ProcessEnv)!;
      const client = createLlmClient(cfg);
      const result = await client.generateText({ prompt: "hi" });

      expect(captured).toEqual({ id: "fake-key::fake-default" });
      expect(result.provider).toBe("fake");
      expect(result.model).toBe("fake-default");
      expect(result.text).toBe("fake-response");
    } finally {
      _unregisterProviderForTests("fake");
    }
  });

  it("memoises the per-provider factory across calls", async () => {
    let invocations = 0;
    const fakeSpec: ProviderSpec = {
      envApiKey: "FAKE_API_KEY",
      envModel: "FAKE_MODEL",
      defaultModel: "fake-default",
      create: () => {
        invocations += 1;
        return (modelId) => ({ tag: modelId } as unknown as Parameters<typeof generateTextMock>[0]["model"]);
      },
    };
    _registerProviderForTests("fake", fakeSpec);
    try {
      generateTextMock.mockResolvedValue({ text: "ok", finishReason: "stop" });
      const cfg = resolveLlmConfig({
        JANUSLY_LLM_PROVIDER: "fake",
        FAKE_API_KEY: "fake-key",
      } as NodeJS.ProcessEnv)!;
      const client = createLlmClient(cfg);
      await client.generateText({ prompt: "a" });
      await client.generateText({ prompt: "b" });
      await client.generateText({ prompt: "c" });
      expect(invocations).toBe(1);
    } finally {
      _unregisterProviderForTests("fake");
    }
  });
});

describe("getLlmClient (memoised singleton)", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    _resetLlmClientForTests();
  });

  it("returns null when no provider key is configured", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.JANUSLY_LLM_PROVIDER;
    expect(getLlmClient()).toBeNull();
  });

  it("memoises the resolved client across calls", () => {
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    delete process.env.JANUSLY_LLM_PROVIDER;
    const a = getLlmClient();
    const b = getLlmClient();
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("returns a client when only a non-default provider key is configured", () => {
    process.env.OPENAI_API_KEY = "sk-x";
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.JANUSLY_LLM_PROVIDER;
    expect(getLlmClient()).not.toBeNull();
  });

  it("respects a manual reset between env mutations", () => {
    delete process.env.OPENAI_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-x";
    const first = getLlmClient();
    _resetLlmClientForTests();
    delete process.env.ANTHROPIC_API_KEY;
    const second = getLlmClient();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });
});

describe("usage recorder fires on success and failure", () => {
  afterEach(() => {
    _resetUsageRecorderForTests();
  });

  it("calls the recorder once on the happy path with full record fields", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await client.generateText({
      prompt: "hi",
      context: { orgId: "org-1", userId: "u-1", runId: "r-1", nodeId: "n-1", workflowId: "wf-1" },
    });
    // Allow the void-fired recorder to settle (microtask flush).
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder).toHaveBeenCalledTimes(1);
    const record = recorder.mock.calls[0][0] as UsageRecord;
    expect(record).toMatchObject({
      orgId: "org-1",
      userId: "u-1",
      runId: "r-1",
      nodeId: "n-1",
      workflowId: "wf-1",
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      providerSimulated: false,
      mode: "ai",
    });
    expect(typeof record.latencyMs).toBe("number");
    expect(record.costUsd).toBeCloseTo(100 * 0.15 / 1e6 + 50 * 0.6 / 1e6, 9);
    expect(record.aiError).toBeUndefined();
  });

  it("records provider-neutral prompt-cache token details when present", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: {
        inputTokens: 120,
        outputTokens: 20,
        inputTokenDetails: {
          noCacheTokens: 20,
          cacheReadTokens: 80,
          cacheWriteTokens: 20,
        },
      },
    });
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({
      JANUSLY_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv)!;

    await createLlmClient(cfg).generateText({
      prompt: "hi",
      context: { orgId: "org-1" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder).toHaveBeenCalledTimes(1);
    expect(recorder.mock.calls[0][0]).toMatchObject({
      cachedInputTokens: 80,
      cacheCreationInputTokens: 20,
    });
  });

  it("falls back to Anthropic metadata and ignores malformed cache counts", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 100, outputTokens: 10 },
      providerMetadata: {
        anthropic: {
          cacheCreationInputTokens: 14,
          usage: { cache_read_input_tokens: 61 },
        },
      },
    });
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({
      JANUSLY_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv)!;

    await createLlmClient(cfg).generateText({ prompt: "hi", context: { orgId: "org-1" } });
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder.mock.calls[0][0]).toMatchObject({
      cachedInputTokens: 61,
      cacheCreationInputTokens: 14,
    });

    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        inputTokenDetails: { cacheReadTokens: -1, cacheWriteTokens: 1.5 },
      },
      providerMetadata: { anthropic: { usage: { cache_read_input_tokens: "many" } } },
    });
    await createLlmClient(cfg).generateText({ prompt: "hi", context: { orgId: "org-1" } });
    await Promise.resolve();
    await Promise.resolve();
    const malformedRecord = recorder.mock.calls[1][0] as UsageRecord;
    expect(malformedRecord.cachedInputTokens).toBeUndefined();
    expect(malformedRecord.cacheCreationInputTokens).toBeUndefined();
  });

  it("calls the recorder once on the failure path with mode='fallback' + aiError", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("rate limit"));
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await expect(
      client.generateText({ prompt: "hi", context: { orgId: "org-1" } }),
    ).rejects.toThrow(/rate limit/);
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder).toHaveBeenCalledTimes(1);
    const record = recorder.mock.calls[0][0] as UsageRecord;
    expect(record.mode).toBe("fallback");
    expect(record.aiError).toBe("rate limit");
    expect(record.provider).toBe("openai");
    expect(record.model).toBe("gpt-4o-mini");
    expect(typeof record.latencyMs).toBe("number");
  });

  it("records provider configuration failures before the SDK call", async () => {
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);

    await expect(
      client.generateText({
        prompt: "hi",
        modelHint: "anthropic/claude-x",
        context: { orgId: "org-1" },
      }),
    ).rejects.toThrow(/anthropic.*not configured.*ANTHROPIC_API_KEY/);
    await Promise.resolve();
    await Promise.resolve();

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(recorder).toHaveBeenCalledTimes(1);
    const record = recorder.mock.calls[0][0] as UsageRecord;
    expect(record).toMatchObject({
      orgId: "org-1",
      provider: "anthropic",
      model: "claude-x",
      mode: "fallback",
      aiError: expect.stringContaining("ANTHROPIC_API_KEY"),
    });
  });

  it("does NOT fire the recorder when context.orgId is absent", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await client.generateText({ prompt: "hi" });
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder).not.toHaveBeenCalled();
  });

  it("a throwing recorder NEVER breaks the LLM call (fail-open)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    setUsageRecorder(() => {
      throw new Error("recorder exploded");
    });
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    const result = await client.generateText({ prompt: "hi", context: { orgId: "org-1" } });
    expect(result.text).toBe("ok");
  });

  it("an async-rejecting recorder NEVER breaks the LLM call (fail-open)", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    setUsageRecorder(async () => {
      throw new Error("async recorder exploded");
    });
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    const result = await client.generateText({ prompt: "hi", context: { orgId: "org-1" } });
    expect(result.text).toBe("ok");
    await Promise.resolve();
    await Promise.resolve();
  });

  it("records costUsd: null when the model has no price entry", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await client.generateText({
      prompt: "hi",
      modelHint: "gpt-future-9000",
      context: { orgId: "org-1" },
    });
    await Promise.resolve();
    await Promise.resolve();
    const record = recorder.mock.calls[0][0] as UsageRecord;
    expect(record.model).toBe("gpt-future-9000");
    expect(record.costUsd).toBeNull();
  });

  it("records simulated provider evidence with zero cost", async () => {
    generateTextMock.mockResolvedValueOnce({
      text: "ok",
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({
      ANTHROPIC_API_KEY: "local-key",
      JANUSLY_LOCAL_STACK: "true",
      JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "true",
      JANUSLY_LLM_SIMULATED_PROVIDERS: "anthropic",
    } as NodeJS.ProcessEnv)!;
    await createLlmClient(cfg).generateText({
      prompt: "hi",
      context: { orgId: "org-1" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.mock.calls[0][0]).toMatchObject({
      provider: "anthropic",
      providerSimulated: true,
      costUsd: 0,
      mode: "ai",
    });
  });

  it("records failed simulated provider calls with zero cost", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("simulated outage"));
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({
      ANTHROPIC_API_KEY: "local-key",
      JANUSLY_LOCAL_STACK: "true",
      JANUSLY_LOCAL_INTEGRATION_SIMULATOR: "true",
      JANUSLY_LLM_SIMULATED_PROVIDERS: "anthropic",
    } as NodeJS.ProcessEnv)!;

    await expect(
      createLlmClient(cfg).generateText({
        prompt: "hi",
        context: { orgId: "org-1" },
      }),
    ).rejects.toThrow("simulated outage");
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.mock.calls[0][0]).toMatchObject({
      provider: "anthropic",
      providerSimulated: true,
      costUsd: 0,
      mode: "fallback",
      aiError: "simulated outage",
    });
  });
});

describe("generateObject (schema-aware generation)", () => {
  // AI SDK 7 exposes the typed payload at `output`. We mock
  // `generateText` (the underlying SDK function) AND `Output.object` (so the
  // schema arg doesn't have to be a real Zod schema) — the abstraction's job
  // is to thread inputs/outputs around, not to validate the schema itself.
  const mockSchema = { __mockZodSchema: "stub" } as never;

  afterEach(() => {
    _resetUsageRecorderForTests();
  });

  it("returns the typed object on the happy path", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: { id: "wf-1", nodes: [], edges: [] },
      finishReason: "stop",
      usage: { inputTokens: 50, outputTokens: 25 },
    });
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    const result = await client.generateObject<{ id: string; nodes: unknown[]; edges: unknown[] }>({
      prompt: "build a workflow",
      schema: mockSchema,
    });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(outputObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ schema: mockSchema }),
    );
    const opts = generateTextMock.mock.calls[0][0];
    expect(opts.output).toBeDefined();
    expect(result.object).toEqual({ id: "wf-1", nodes: [], edges: [] });
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o-mini");
    expect(typeof result.latencyMs).toBe("number");
    expect(result.costUsd).toBeCloseTo((50 * 0.15 + 25 * 0.6) / 1e6, 9);
  });

  it("records cache token details for structured output calls", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: { id: "wf-cache" },
      finishReason: "stop",
      usage: {
        inputTokens: 90,
        outputTokens: 10,
        inputTokenDetails: { cacheReadTokens: 70, cacheWriteTokens: 5 },
      },
    });
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({
      JANUSLY_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv)!;

    await createLlmClient(cfg).generateObject({
      prompt: "hi",
      schema: mockSchema,
      context: { orgId: "org-1" },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder.mock.calls[0][0]).toMatchObject({
      cachedInputTokens: 70,
      cacheCreationInputTokens: 5,
    });
  });

  it("throws and fires the recorder with mode='fallback' on schema rejection", async () => {
    generateTextMock.mockRejectedValueOnce(new Error("NoObjectGeneratedError: schema invalid"));
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await expect(
      client.generateObject({
        prompt: "hi",
        schema: mockSchema,
        context: { orgId: "org-1" },
      }),
    ).rejects.toThrow(/NoObjectGeneratedError/);
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder).toHaveBeenCalledTimes(1);
    const record = recorder.mock.calls[0][0] as UsageRecord;
    expect(record.mode).toBe("fallback");
    expect(record.aiError).toContain("NoObjectGeneratedError");
    expect(record.provider).toBe("openai");
  });

  it("throws and records fallback when the SDK returns no output", async () => {
    generateTextMock.mockResolvedValueOnce({
      // Neither field present — defensive guard fires.
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await expect(
      client.generateObject({
        prompt: "hi",
        schema: mockSchema,
        context: { orgId: "org-1" },
      }),
    ).rejects.toThrow(/SDK did not return a parsed output/);
    await Promise.resolve();
    await Promise.resolve();

    expect(recorder).toHaveBeenCalledTimes(1);
    const record = recorder.mock.calls[0][0] as UsageRecord;
    expect(record).toMatchObject({
      orgId: "org-1",
      provider: "openai",
      model: "gpt-4o-mini",
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      mode: "fallback",
      aiError: expect.stringContaining("SDK did not return a parsed output"),
    });
  });

  it("threads a 'provider/model' spec through to the resolved provider", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: { id: "wf-3" },
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const cfg = resolveLlmConfig({
      OPENAI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    const result = await client.generateObject({
      prompt: "hi",
      schema: mockSchema,
      modelHint: "anthropic/claude-haiku-4-5",
    });
    expect(result.provider).toBe("anthropic");
    expect(result.model).toBe("claude-haiku-4-5");
  });

  it("a throwing recorder NEVER breaks generateObject (fail-open)", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: { id: "wf-4" },
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    setUsageRecorder(() => {
      throw new Error("recorder exploded");
    });
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    const result = await client.generateObject<{ id: string }>({
      prompt: "hi",
      schema: mockSchema,
      context: { orgId: "org-1" },
    });
    expect(result.object).toEqual({ id: "wf-4" });
  });

  it("does NOT fire the recorder when context.orgId is absent", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: { id: "wf-5" },
      finishReason: "stop",
    });
    const recorder = vi.fn();
    setUsageRecorder(recorder);
    const cfg = resolveLlmConfig({ JANUSLY_LLM_PROVIDER: "openai", OPENAI_API_KEY: "sk-x" } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await client.generateObject({ prompt: "hi", schema: mockSchema });
    await Promise.resolve();
    await Promise.resolve();
    expect(recorder).not.toHaveBeenCalled();
  });
});

describe("cacheSystemPrompt — Anthropic ephemeral system-prompt caching", () => {
  beforeEach(() => {
    generateTextMock.mockResolvedValue({ text: "ok", finishReason: "stop", usage: baseUsage });
  });

  const anthropicCfg = () =>
    resolveLlmConfig({
      JANUSLY_LLM_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv)!;

  it("marks the system prompt as an Anthropic cache breakpoint when enabled (generateText)", async () => {
    const client = createLlmClient(anthropicCfg());
    await client.generateText({ system: "big static prompt", prompt: "draft a flow", cacheSystemPrompt: true });

    const opts = generateTextMock.mock.calls[0][0];
    // `system` becomes a SystemModelMessage carrying the cache breakpoint…
    expect(opts.system).toEqual({
      role: "system",
      content: "big static prompt",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
    // …and the user prompt is unchanged (still a plain string).
    expect(opts.prompt).toBe("draft a flow");
  });

  it("leaves the system prompt a plain string when the flag is off", async () => {
    const client = createLlmClient(anthropicCfg());
    await client.generateText({ system: "big static prompt", prompt: "draft a flow" });

    const opts = generateTextMock.mock.calls[0][0];
    expect(opts.system).toBe("big static prompt");
  });

  it("does NOT cache when there is no system prompt (nothing to mark)", async () => {
    const client = createLlmClient(anthropicCfg());
    await client.generateText({ prompt: "draft a flow", cacheSystemPrompt: true });

    const opts = generateTextMock.mock.calls[0][0];
    expect(opts.system).toBeUndefined();
  });

  it("does NOT cache when the EFFECTIVE provider is not Anthropic (override to openai)", async () => {
    const cfg = resolveLlmConfig({
      OPENAI_API_KEY: "sk-x",
      ANTHROPIC_API_KEY: "sk-ant-x",
    } as NodeJS.ProcessEnv)!;
    const client = createLlmClient(cfg);
    await client.generateText({
      system: "big static prompt",
      prompt: "draft a flow",
      cacheSystemPrompt: true,
      modelHint: "openai/gpt-4o",
    });

    const opts = generateTextMock.mock.calls[0][0];
    // Anthropic cacheControl must NEVER reach a non-Anthropic provider.
    expect(opts.system).toBe("big static prompt");
  });

  it("applies the cache breakpoint on the generateObject path too", async () => {
    generateTextMock.mockResolvedValueOnce({
      output: { id: "wf-cache" },
      finishReason: "stop",
      usage: baseUsage,
    });
    const client = createLlmClient(anthropicCfg());
    await client.generateObject({
      system: "big static prompt",
      prompt: "draft a flow",
      schema: { __mockZodSchema: "stub" } as never,
      cacheSystemPrompt: true,
    });

    const opts = generateTextMock.mock.calls[0][0];
    expect(opts.system).toEqual({
      role: "system",
      content: "big static prompt",
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    });
  });
});
