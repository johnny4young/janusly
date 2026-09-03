# Changelog

## Unreleased

- Local and hosted acceptance now share the frontend vulnerability audit;
  `make verify` uses a fresh, isolated PostgreSQL 18 project, applies the
  baseline twice, and cleans only resources it owns.
- `/healthz` remains process liveness while `/readyz` performs an opaque,
  bounded database readiness check suitable for routing and Railway
  healthchecks.
- Operator CLI traffic uses one bounded fixed-origin client with same-origin
  redirects, response limits, strict JSON, encoded paths, and explicit token
  precedence.
- Private metrics can be qualified across the same isolated network boundary
  required by a separate Alloy collector without publishing the privileged
  listener or contacting Grafana Cloud.
- Container, PostgreSQL, observability, and optional provider images are pinned
  by digest; CI Actions are pinned by commit. `make supply-chain` produces
  checksummed BuildKit provenance metadata, a saved image, and an SPDX 2.3 SBOM
  using digest-pinned generators. The evidence remains unsigned and local.

## New baseline — 2026-08-03

- Janusly is now a root-level Go module with a standalone React frontend in
  `/web`.
- Production ships one `janusly` executable that serves React, the public API,
  workflow execution, and maintenance loops.
- PostgreSQL 18 is the only supported database version. New installations use
  one fresh baseline migration and cannot upgrade databases from other schema
  generations.
- Runtime configuration uses `JANUSLY_*` names, with `JANUSLY_ENV=production`
  as the single production gate.
- Docker Compose contains Janusly, PostgreSQL 18, and optional Ollama services.
- CI validates frontend, backend, PostgreSQL 18 integration, the single-runtime
  browser journey, and provenance-bearing artifacts.
