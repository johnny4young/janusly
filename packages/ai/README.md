# `@janusly/ai`

Provider-neutral LLM abstraction + the run explainer. Every AI surface in Janusly speaks through this package — no other workspace imports `openai`, `@ai-sdk/openai`, or any other vendor SDK directly.

## What this package exposes

| Export | What it is |
| --- | --- |
| `LlmClient` | One-method interface (`generateText`) every caller depends on. |
| `getLlmClient()` | Memoised singleton resolved from `process.env`. Returns `null` only when no registered provider key is configured. |
| `createLlmClient(cfg)` | Build a client from a hand-crafted `ResolvedLlmConfig` (mostly used by tests). |
| `resolveLlmConfig(env)` | Read the env vars listed below into a fully-defaulted config. Pure over `env`. |
| `explainRun({ llm, run, events, question, model })` | Run-level Q&A used by `POST /ai/explain-run`. Falls back to the deterministic `fallbackExplainRun` on any error. |
| `_resetLlmClientForTests()` / `_registerProviderForTests(name, spec)` / `_unregisterProviderForTests(name)` | Underscore-prefixed test escapes. **Never call from production code.** |

## Env vars per provider

| Variable | Provider | Purpose | Default |
| --- | --- | --- | --- |
| `JANUSLY_LLM_PROVIDER` | _switch_ | Selects the deploy-time default backend. | `openai` |
| `OPENAI_API_KEY` | openai | API key. Absent ⇒ AI surfaces degrade to fallback. | _(unset)_ |
| `OPENAI_MODEL` | openai | Override default model id. | `gpt-4o-mini` |
| `ANTHROPIC_API_KEY` | anthropic | API key. | _(unset)_ |
| `ANTHROPIC_MODEL` | anthropic | Override default model id. | `claude-haiku-4-5-20251001` |
| `OPENAI_TIMEOUT_MS` | _shared_ | Per-call timeout (passed to `AbortSignal.timeout`). | `30000` |
| `OPENAI_MAX_RETRIES` | _shared_ | AI SDK retries on rate-limit + 5xx. | `2` |

The `OPENAI_TIMEOUT_MS` / `OPENAI_MAX_RETRIES` names are kept under the `OPENAI_*` prefix for back-compat; they apply to every provider.

## Per-call provider+model spec

Both `LlmGenerateTextInput.modelHint` and the `model` field on workflow nodes / API request bodies accept either form:

| Form | Meaning |
| --- | --- |
| `"gpt-4o-mini"` | Bare model id — uses the configured provider, this model. |
| `"anthropic/claude-haiku-4-5-20251001"` | `<provider>/<model>` — overrides provider for that one call, ignoring `JANUSLY_LLM_PROVIDER`. |

The latter requires the named provider's API key to be present; absent → throws a descriptive error caught by the caller's try/catch and surfaced as `aiError`. A non-default provider key is enough for explicit overrides to work; the deploy-time default key is only required for calls that do not name a provider.

A workflow author writing this on a single `ai` node:

```json
{ "type": "ai", "config": { "prompt": "…", "model": "anthropic/claude-haiku-4-5-20251001" } }
```

…runs THAT node alone against Anthropic, regardless of the deploy's `JANUSLY_LLM_PROVIDER`. Per-step provider override comes for free.

## Adding a provider in 4 fields

`packages/ai/src/llm-client.ts` owns the `PROVIDERS` registry. Adding a new vendor is a single record entry:

```ts
import { createOllama } from "@ai-sdk/ollama";

const PROVIDERS = {
  // … existing entries …
  ollama: {
    envApiKey: "OLLAMA_BASE_URL",
    envModel: "OLLAMA_MODEL",
    defaultModel: "llama3.1",
    create: (apiKey) => {
      const ollama = createOllama({ baseURL: apiKey });
      return (modelId) => ollama(modelId);
    },
    // No jsonModeOptions — Ollama JSON mode varies by model; rely on the prompt.
  },
};
```

Add `@ai-sdk/ollama` to `package.json`, append the entry, ship. The factory, the env loader, the per-call override path all read from `PROVIDERS` directly — no other code changes. The contract is locked down by the registry-extensibility test in `llm-client.test.ts`.

## Fallback contract — the highest-risk invariant

Every caller wraps `llm.generateText(...)` in try/catch and degrades to `{ mode: "fallback", aiError, ... }` with a deterministic local answer attached. This module deliberately **throws** on unknown providers and missing override keys so they flow through the same try/catch — see [`AGENTS.md`](../../AGENTS.md) "AI integration" bullet for the project-wide invariant.

## Slash collision in spec strings

The `"<provider>/<model>"` syntax assumes neither the provider name nor the model id contains `/`. Today's stock providers (`openai`, `anthropic`, future `ollama` / `mistral` / `google`) and their model ids all avoid `/`. If a future model id contains `/`, the syntax becomes a breaking change — re-evaluate then.
