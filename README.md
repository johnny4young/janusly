# Workflow Engine

Production-oriented workflow engine built with Node.js, TypeScript, tRPC, Drizzle, BullMQ, Redis and React Flow.

## Architecture

```txt
apps/web       -> Workflow editor UI with React Flow
apps/api       -> tRPC API for workflow/run operations
apps/worker    -> BullMQ worker for async node execution
packages/engine -> Runtime, scheduler, queue and execution logic
packages/db     -> Drizzle schema and database client
packages/shared -> Shared types and Zod schemas
```

## Local development

```bash
pnpm install
cp .env.example .env
docker compose up -d
pnpm dev
```

## Core concepts

- A workflow is a versioned DAG.
- A run is an execution of a published workflow version.
- Each node execution is persisted as `run_nodes`.
- BullMQ executes ready nodes asynchronously.
- Webhook and approval nodes can pause and resume a run.

## Roadmap

- [x] Initial monorepo skeleton
- [x] Drizzle schema draft
- [x] BullMQ queue draft
- [x] Engine runner draft
- [ ] tRPC full API
- [ ] React Flow editor
- [ ] Timeline/logs UI
- [ ] Webhook resume endpoint
- [ ] Script sandbox
