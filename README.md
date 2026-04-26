# Workflow Engine

Motor de workflows orientado a ejecución asíncrona y distribuida de DAGs, con API, worker y UI en un monorepo de PNPM.

---

## Arquitectura

```txt
apps/
  api        -> API HTTP (control plane)
  web        -> UI React + Vite + React Flow

packages/
  engine     -> runtime, scheduler, ejecutores y worker BullMQ
  db         -> esquema y cliente Drizzle/Postgres
  shared     -> contratos y validaciones compartidas
```

> Nota: el worker vive en `packages/engine/src/worker.ts` y se ejecuta con `pnpm --filter @workflow-engine/engine dev`.

---

## Requisitos

- Node.js 20+
- PNPM 8 (`corepack enable`)
- Postgres 15+
- Redis 7+

---

## Instalación local

```bash
pnpm install
cp .env.example .env
docker compose up -d redis postgres
```

Variables mínimas (`.env`):

```env
REDIS_URL=redis://localhost:6379
DATABASE_URL=postgres://postgres:postgres@localhost:5432/workflow
WORKER_CONCURRENCY=10
# opcional para auth real
# SUPABASE_URL=...
# SUPABASE_SERVICE_ROLE_KEY=...
```

---

## Ejecutar el proyecto

En terminales separadas:

```bash
pnpm --filter @workflow-engine/api dev
pnpm --filter @workflow-engine/engine dev
pnpm --filter @workflow-engine/web dev
```

- API: `http://localhost:3001`
- UI: `http://localhost:5173`

Si no configuras Supabase en el frontend, la UI entra en modo desarrollo y usa headers dev (`x-org-id`, `x-user-id`).

---

## Validación rápida (backend + UI)

```bash
pnpm build
pnpm test
```

Checks manuales útiles:

- `GET /tools` en API.
- `POST /validate` con un DAG.
- Desde la UI: validar workflow, guardar versión y correr un run.

---

## Roles y permisos

- `viewer`: lectura.
- `editor`: puede validar, guardar workflows y ejecutar/resumir runs.
- `admin`: gestión de miembros, plugins y credenciales.

La API valida permisos por organización con `org_members`.

---

## Estado actual

### Implementado

- Persistencia en Postgres (workflows, versiones, runs, eventos, membresías, auditoría).
- Cola BullMQ + worker.
- Validación de workflows (nodos, edges, ciclos, nodo de inicio).
- UI de edición, historial, miembros y timeline de ejecución.

### En progreso

- Endpoints tRPC completos (hoy coexisten rutas HTTP directas).
- Harden de expresiones condicionales y sandboxing.

---

## Testing

- Se incluye base de pruebas unitarias en frontend con **Vitest** (ecosistema Vite).
- Recomendación siguiente: agregar pruebas unitarias en `packages/engine` para scheduler/validación/templating.
