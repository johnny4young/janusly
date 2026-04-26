# Workflow Engine

Motor de workflows orientado a ejecución asíncrona y distribuida de DAGs.

---

## Arquitectura del monorepo

```txt
apps/
  api        -> API HTTP para control de workflows, ejecuciones, auth/roles
  web        -> UI (Vite + React + React Flow)

packages/
  db         -> esquema y cliente Drizzle/Postgres
  engine     -> runtime de ejecución (scheduler, worker, validación)
  shared     -> contratos/tipos compartidos
```

> Nota: anteriormente se referenciaba `apps/worker`, pero el worker vive en `packages/engine/src/worker.ts`.

---

## Requisitos

- Node.js 22+
- pnpm 8.15+
- PostgreSQL
- Redis
- (Opcional) Supabase para auth real

---

## Variables de entorno

Copia `.env.example` y completa valores:

```bash
cp .env.example .env
```

Variables principales:

- `DATABASE_URL`: conexión a Postgres
- `REDIS_URL`: conexión a Redis
- `PORT`: puerto de API (default `3001`)
- `OPENAI_API_KEY`: opcional para helpers de IA
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY`: opcional para JWT vía Supabase
- `API_SERVICE_TOKEN`: opcional para auth máquina-a-máquina
- `VITE_API_URL`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`: frontend

---

## Instalación

```bash
pnpm install
```

Si el entorno no permite descargar paquetes (red corporativa/proxy), usa el lockfile/cache corporativo o ejecuta la instalación dentro de tu red interna.

---

## Desarrollo local

### Backend (API)

```bash
pnpm --filter @workflow-engine/api dev
```

### Worker

```bash
pnpm --filter @workflow-engine/engine dev
```

### Frontend (UI)

```bash
pnpm --filter @workflow-engine/web dev
```

---

## Build

```bash
pnpm build
```

---

## Testing

### Unit tests (engine/shared)

```bash
pnpm --filter @workflow-engine/shared test
pnpm --filter @workflow-engine/engine test
```

### UI smoke build (Vite)

```bash
pnpm --filter @workflow-engine/web test
```

---

## Modelo y contratos principales

### Entidades

- `workflows`
- `workflow_versions`
- `runs`
- `run_nodes`
- `run_events`
- `org_members`
- `credentials`
- `installed_plugins`
- `audit_logs`

### Contratos clave

- Workflow DAG: `id`, `nodes[]`, `edges[]`
- Node: `id`, `type`, `config`
- Edge: `from`, `to`, `condition?`

Validación en runtime: tipos soportados, ciclos, nodos duplicados, endpoints de edges, requisitos por tipo de nodo (`http.url`, `tool.tool`, etc.).

---

## Roles y permisos

Roles soportados:

- `viewer`
- `editor`
- `admin`

Regla: `admin > editor > viewer`.

- `viewer`: lectura
- `editor`: operar workflows/runs
- `admin`: miembros, credenciales, plugins

Principio aplicado: mínimo privilegio por defecto.

---

## Estado actual

Implementado:

- API HTTP para workflows, runs, miembros, auditoría, plugins, credenciales
- Motor base de ejecución y scheduler
- UI editor con React Flow
- Validación de workflows
- Pruebas unitarias iniciales de contratos/validación

Pendiente sugerido:

- integración e2e API + Worker + DB + Redis
- pruebas de UI interactivas (Vitest + RTL)
- versionado robusto de `workflowVersionId` al iniciar runs
