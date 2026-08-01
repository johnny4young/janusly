# F1 — inventario de gaps: el web real contra Go (ESTADO TERMINAL)

Cierre: 2026-08-01 (T-183) · Método: enumeración de TODOS los call sites
`api()` / `downloadFromApi()` de `apps/web/src` en el pin, sondeados contra
el binario Go corriendo (dev-headers), con el wire real del cliente:
**GETs del set `V1_READ_PATHS` van a `/v1` con envelope; todo lo demás
(mutaciones Y lecturas fuera del set) va legacy crudo; `downloadFromApi`
siempre va crudo sin `/v1`.**

## Cómo habla el web (verificado en fuente — sin cambios)

1. `VITE_API_URL` (default `:3001`) — apuntar a Go = una variable.
2. Dev-headers `x-org-id: default` + `x-user-id: dev-user` por request.
3. GETs de `V1_READ_PATHS` → prefijo `/v1`, el cliente des-envuelve
   `{apiVersion, requestId, data|error}` él mismo.
4. Mutaciones (POST/DELETE) → SIEMPRE rutas legacy sin envelope.
5. Excepción documentada: `/dlq?id=` (detalle) va legacy.
6. El wrapper degrada offline-limpio: 404/red caída → mensaje amigable
   por panel (`ErrorBoundary`), nunca crash de página.

## ✅ Servido (verificado por sondeo + suites)

Toda la superficie que el web toca en Home / Flows / AI Studio / Activity
/ Operations responde no-404 en su wire real. Cierres finales de T-183:

| Ruta (wire real) | Cierre |
| --- | --- |
| `GET /v1/templates` (+ alias legacy) | catálogo de 15 templates del reference EMBEBIDO VERBATIM (`internal/httpapi/assets/templates.json`, decoración `nameCode`/`descriptionCode`/`categoryCode` incluida) |
| `GET /v1/workflows/schedule-preview` (+ legacy) | `{valid, nextFires[3]}` sobre `internal/cron`; cron inválido = `{valid:false}`, nunca error |
| `GET /v1/workflows/health` | alias envelope del core legacy (T-181) |
| `GET /v1/run/usage` | alias envelope del core legacy (tenancy-first 403 intacto) |
| `GET /v1/memory/consent-status` | `{enabled, processEnabled, tenantEnabled, purge}`; `purge` derivado del estado durable del pilot (flip de `memory.enabled` + ventana del sweep) en el union del reference (`none/scheduled/running/unknown`) |
| `GET /recovery/calibration-status` | `{enabled, windowDays:30, minimumSampleSize:20, calibrations}` sobre el repo de calibraciones existente |
| `GET /mcp/connections` | lista con `toolCount`/`enabledToolCount` por conexión (mismo join del reference) |

Verificados como falsos positivos del sondeo (ya servían): rutas con
path-param sobre entidad inexistente (404 correcto de dominio: metadata/
folder/tags/restore sobre workflow fantasma, playbooks/items fantasma),
`/reports/run-explain` (el web lo consume vía `downloadFromApi` crudo —
servido desde T-147) y `GET /recovery/playbooks` (el web solo POSTea la
promoción; no existe listado en el cliente).

## 🟡 Divergencias documentadas (el panel degrada limpio — probado por el
## smoke de todos los tabs sin pageerrors)

| Superficie | Decisión |
| --- | --- |
| `POST /ai/explain-run` · `/ai/explain-workflow` · `/ai/review-workflow` · `/ai/suggest-improvement` · `GET /ai/health` | fuera del corte de la ola 4 (el pilot sirve generate/patch + evidencia); los botones AI secundarios degradan con mensaje amigable → destino: cutover parcial post-pilot |
| `GET/POST /workflows/{id}/budget` · `GET /billing/budget` · `GET /billing/usage` | el gate de presupuesto del pilot vive en org config (`ai.budgetMonthlyUsd`, T-103); la superficie por-workflow y los paneles billing quedan al cutover (columnas billing del schema son placeholders) |
| `POST /workflows/{id}/slo` | decisión T-181: el SLO viaja en el save body → `workflow_versions.slo_json`; la ruta dedicada del web degrada (el editor de SLO del canvas usa save) |
| `GET /recovery/ledger` · `/recovery/my-wins` · `/recovery/cases` | miembros del set v1 que el web de este pin NO llama (contrato superset); la superficie semántica V2 del pilot es `/recovery/home` + `/recovery/items` + métricas |
| `POST /causal` | panel de razonamiento causal — no entró en ninguna ola del pilot; degrada |
| `POST /runs/replay-lab` + `/fork` | replay lab UI — diferido (el redrive/replay operativo está cubierto por DLQ/campañas) |
| `GET /organizations` · `POST /users/me` · `POST /plugins/install` · `POST /auth/invitations/accept` | multi-org switcher / perfil / plugins / aceptación de invitación por página — flujos de identidad secundarios, degradan; destino: cutover de auth completo |
| `GET /ping` | NO es ruta del servidor Node (falso positivo original) — cerrado |

## Cero gaps sin clasificar

Cada ruta enumerada de `apps/web/src` está en una de las dos tablas de
arriba. La evidencia ejecutable es `TestF1SweepReadClosures` + el smoke
Playwright de todos los tabs (`go-pilot-smoke.spec.ts`) vía
`node go/conformance/run-web-smoke.mjs`.
