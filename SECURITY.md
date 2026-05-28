# Security policy

## Reporting a vulnerability

If you discover a security issue in Janusly, please email **security@janusly.com** with a description of the issue, a reproducer (or the smallest set of steps that surface it), and your assessment of impact and severity. We aim to acknowledge reports within two business days and to have a fix or mitigation in place for `high` and `critical` issues within thirty days.

Please do not open a public GitHub issue for security-sensitive reports. Use the email address above so we can coordinate disclosure responsibly.

## Supported branches

Security fixes ship on the default branch (`main`). Older branches are not maintained.

## Known transitive advisories

CI runs `pnpm audit --audit-level moderate` on every push and PR. Direct dependencies are kept current, but a small set of transitive advisories cannot be cleanly overridden because the upstream peer-dep ranges block the patched version. Each one below is silenced in `pnpm-workspace.yaml > auditConfig.ignoreGhsas` with the explicit rationale that the advisory's vector does not apply to Janusly's usage. We revisit each entry monthly, or sooner if the upstream releases a compatible bump.

### `uuid@8.3.2` (GHSA-w5hq-g745-h8pq)

- **Advisory:** "Missing buffer bounds check in v3/v5/v6 when `buf` is provided." Threshold: `>= 11.1.1`. Severity: moderate.
- **Parent chain:** `@opentelemetry/exporter-jaeger > jaeger-client > uuid`.
- **Why it is safe in Janusly today:** the vulnerable code path is reached only when a caller passes a user-controlled `buf` argument into `uuid.v3` / `v5` / `v6` for in-place generation. Janusly does not call `uuid` from its own code; the only consumer is OpenTelemetry's Jaeger exporter, which uses the default-allocation v1/v4 paths to mint trace and span identifiers. Those code paths do not accept a `buf` argument. The advisory itself notes the practical impact is on the browser ESM build of `uuid`; Janusly never bundles `uuid` into its web client (`apps/web` consumes a closed list of dependencies — `react`, `react-dom`, `@xyflow/react`, `@supabase/supabase-js`, `zustand`, `lucide-react`, `i18next`, `react-i18next` — `uuid` is not in that set).
- **Upstream blocker:** `jaeger-client@3.19.0` peer-locks against the v8 API. A `uuid >= 11` override breaks the exporter because v11 dropped the default export and shipped breaking changes against v8.
- **Revisit trigger:** drop the audit ignore the moment `@opentelemetry/exporter-jaeger` (or `jaeger-client` directly) releases a version that consumes `uuid >= 11.1.1`. Alternative path: if the OpenTelemetry community deprecates the Jaeger exporter in favor of OTLP and we drop the dep, the override goes with it.
- **Last reviewed:** 2026-05-28.
