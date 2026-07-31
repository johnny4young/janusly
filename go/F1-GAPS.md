# F1 — inventario de gaps: el web real contra Go

Fecha: 2026-07-30 · Fuente: lectura estática de `apps/web/src/api.ts` +
`packages/shared/src/api-contract.ts` en el pin, contrastada con la
superficie Go actual. Deliverable de T-029; los tickets T-030..T-035 se
ejecutan contra esta tabla.

## Cómo habla el web (verificado en fuente)

1. `VITE_API_URL` (default `:3001`) — apuntar a Go = una variable.
2. Dev-headers `x-org-id: default` + `x-user-id: dev-user` en cada request
   (compatibles con el auth del pilot tal cual). Supabase JWT solo si hay
   sesión — fuera del alcance F1.
3. **GETs** de la lista `V1_READ_PATHS` viajan con prefijo `/v1` y el
   cliente des-envuelve `{apiVersion, requestId, data|error}` él mismo
   (`unwrapVersionedPayload`). Errores v1 → `{error: message, code, params}`.
4. **Mutaciones (POST/DELETE) van SIEMPRE a rutas legacy** sin envelope
   (`versionedWirePath` corta en `method !== 'GET'`).
5. Excepción documentada: `/dlq?id=` (detalle) va legacy aunque `/dlq` esté
   en el set v1.
6. El wrapper degrada offline-limpio: una ruta ausente (404) o red caída
   produce mensaje amigable, no crash — los paneles fuera de alcance
   degradan solos.

## Matriz de superficie

### ✅ Ya servido por Go (alineado con el set v1 del web)

`GET /v1/workflows` · `/v1/workflows/latest` · `/v1/workflows/versions` ·
`/v1/runs` (keyset+filtros) · `/v1/run` · `/v1/status` · `/v1/dlq` (lista).

### 🔴 Bloqueante F1 — mutaciones legacy (el web NO llama /v1 en POST)

| Ruta legacy | Forma de respuesta legacy (Node) | Estado Go |
| --- | --- | --- |
| `POST /start` | cuerpo crudo (sin envelope) | solo /v1 → **alias legacy pendiente** |
| `POST /resume` | crudo | ídem |
| `POST /run/cancel` | crudo `{runId, status}` | ídem |
| `POST /workflows/save` | crudo `{workflowId, versionId, version}` | ídem |
| `POST /dlq/replay` | crudo `{ok:true}` | ídem |

Diseño: refactor de handlers a `(status, payload, errShape)` + dos
encoders (legacy crudo / envelope v1). Un handler, dos wires — igual que
Node. → **T-032**.

### 🔴 Bloqueante F1 — lecturas fuera del set v1 (legacy directo)

| Ruta | Uso en el web | Nota |
| --- | --- | --- |
| `GET /health` | chip de rate-limiter en Operations (poll 20s) | forma pública-segura de Node → T-030 |
| `GET /ping` | latido de conectividad | trivial → T-030 |
| `GET /users/me` | identidad + rol del menú | dev-mode: derivar de headers → T-030 |
| `GET /org/config` | ajustes de tenant en paneles | subset read-only honesto → T-030/T-043 |
| `GET /onboarding` | tarjeta "first recovered run" | stub honesto → T-030 |
| `GET /workflows/trash` | papelera de Flows | tras soft-delete → T-033 |
| `GET /dlq/queue` / `/dlq/counts` | panel DLQ keyset + badges | → T-032/T-044 |
| `GET /dlq?id=` | detalle de dead letter | legacy por diseño → T-032 |
| `GET /runs/:id/stream` | vivo del run (SSE) | → T-031 |

### 🟡 Fuera de alcance F1 (degradación limpia esperada, verificar en T-035)

`/ai/*` (generate/patch/explain) · `/credentials` · `/members` ·
`/org/roles` · `/mcp/connections` · `/org/scim/*` · `/alerts/policies` ·
`/integrations/*` · `/eval/datasets` · `/recovery/*` (métricas/casos) ·
`/templates` · `/tools` · `/workflows/tags|folders` · `/organizations` ·
`/runs/replay-lab` · `/workflows/health` · `/reports/run-explain` ·
`/run/usage`.

Los paneles que dependen de estos deben mostrar su estado vacío/error
amigable, no romper la página (el `ErrorBoundary` por panel de Node ayuda).
El smoke T-035 verifica exactamente eso.

## Ajustes al plan de la ola

- T-030 crece: `/health` + `/ping` + `/users/me` + `/org/config` (subset) +
  `/onboarding` (stub honesto).
- T-032 se concreta: encoders duales + alias de mutaciones legacy + `/dlq`
  detalle + `/dlq/queue` + `/dlq/counts`.
- T-035 (smoke Playwright) valida: Home carga, Flows lista/salva, Activity
  muestra runs, run detail con timeline, y los paneles fuera de alcance
  degradan sin romper.
