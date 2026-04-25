# Workflow Engine

A production-oriented workflow engine designed for asynchronous, distributed execution of DAG-based workflows.

---

## Architecture Overview

This system is built as a modular monorepo using a layered architecture:

```
apps/
  api        -> tRPC API (control plane)
  worker     -> BullMQ workers (execution plane)
  web        -> React Flow editor (UI)

packages/
  engine     -> Workflow runtime & execution engine
  db         -> Drizzle ORM schema & DB client
  shared     -> Types, contracts, schemas
```

---

## Core Concepts

### Workflow
A versioned Directed Acyclic Graph (DAG) describing execution logic.

### Run
An execution instance of a workflow version.

### Node
A unit of work (task, condition, webhook, approval).

### Run Node
Persisted execution state of each node inside a run.

### Event Log
Append-only log for debugging, auditing, and replay.

---

## Execution Model

- Nodes are executed asynchronously using BullMQ.
- Dependencies are resolved dynamically.
- Execution is distributed across workers.
- Each node execution is persisted (idempotent design).
- Retries are handled automatically with exponential backoff.

---

## Data Model

Main tables:

- workflows
- workflow_versions
- runs
- run_nodes
- run_events

### Key Decisions

- Event sourcing-lite via `run_events`
- Node-level persistence (not just run-level)
- Explicit statuses for orchestration control

---

## Engine Responsibilities

The engine layer is responsible for:

- Scheduling nodes when dependencies are met
- Executing tasks
- Managing retries and failures
- Handling pause/resume flows
- Emitting execution events

---

## Queue System

- Powered by BullMQ
- Redis-backed
- Supports retries, backoff, concurrency control

---

## Technical Stack

- Node.js + TypeScript
- BullMQ (queue system)
- Redis (job orchestration)
- Postgres (state persistence)
- Drizzle ORM
- tRPC
- React Flow (UI)

---

## Design Goals

- Deterministic execution
- Horizontal scalability
- Idempotent operations
- Observability-first design
- Extensibility (AI, rules, automation)

---

## Current Status

### Implemented

- Monorepo structure
- Database schema (Drizzle)
- Queue system (BullMQ)
- Worker bootstrap

### In Progress

- Execution engine (scheduler + executor)
- API layer (tRPC)
- UI editor

---

## Next Steps

- Implement execution engine (scheduler + DAG traversal)
- Add run lifecycle management
- Build API endpoints (start, resume, status)
- Add observability (logs + timeline UI)

---

## Future Enhancements

- State machines (XState integration)
- AI-driven nodes
- Plugin system for tasks
- Multi-tenant support
- Distributed workers (Kubernetes-ready)

---

## Philosophy

This project aims to sit between:

- n8n (ease of use)
- Temporal (power and scalability)

Delivering a flexible, developer-first workflow engine with strong execution guarantees.
