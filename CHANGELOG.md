# Changelog

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
