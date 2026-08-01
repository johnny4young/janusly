# Mapa de cutover por ruta — strangler Node → Go

Fecha: 2026-08-01 (T-184) · Evidencia ejecutable:
`node go/conformance/run-reference-stack.mjs node go/conformance/run-dual.mjs`
(**27/27 casos idénticos tras normalización**, divergencias esperadas
anotadas abajo), suite `make parity` (F01.. semánticos), smoke Playwright
de 15 tabs, y las suites de integración por módulo.

## Principio

El proxy corta POR FAMILIA DE RUTA, no por servicio. Cada familia migra
cuando su evidencia está verde; el rollback es apuntar la familia de
vuelta a Node (el estado vive en el MISMO Postgres — no hay migración de
datos en el switch). Dirección estratégica 2026-07-31: **ninguna familia
tiene exclusión permanente** — toda ruta tiene fase, no "si".

## Fases

| Fase | Familias | Estado de evidencia |
| --- | --- | --- |
| **1 — núcleo de ejecución** | `/workflows/*` (save/rollback/versions/latest/trash/restore/readiness/validate), `/start` `/resume` `/run*` `/runs*` (+ `/v1` reads), `/dlq*` completo, webhooks firmados (`/webhooks/*`), triggers (`/v1/triggers/*`), `/auth/context`, `/org/config`, `/health` | dual-run 27/27 + paridad semántica + smokes; **lista** |
| **2 — operación y recuperación** | `/recovery/*` (home/items/metrics/campaigns/playbooks/feedback/calibration-status/drills), `/alerts/*`, `/auto-healing/*`, `/upstream/*`, `/reports/run-explain`, `/system/*`, `/audit` | suites de integración por módulo verdes; smoke de tabs Activity/Operations sin pageerrors; **lista** |
| **3 — administración** | `/members*`, `/org/roles*`, `/org/permissions/*`, `/org/scim/*` (+ webhook WorkOS), `/credentials*`, `/mcp/*`, `/integrations/*`, `/eval/*`, `/experiments*`, `/snippets*`, `/solution-packs*`, `/templates`, `/tools`, `/onboarding`, `/workflows/health*`, metadata/tags/folders | suites verdes (SCIM con fixtures WorkOS; matriz authz central); **lista** |
| **4 — superficies AI** | `/ai/generate-workflow`, `/ai/patch-workflow` (listas); `/ai/explain-run`, `/ai/explain-workflow`, `/ai/review-workflow`, `/ai/suggest-improvement`, `/ai/health` (**Node hasta portarlas** — degradan limpio en el web) | generate/patch con $0 fallback probado; el resto queda en Node en el split |
| **5 — colas del cutover total** | `/billing/*` + `/workflows/{id}/budget`, `/causal`, `/runs/replay-lab*`, `/organizations`, `/users/me`, `/plugins/install`, `/auth/invitations/accept`, `/recovery/ledger|my-wins|cases` | flujos secundarios; Node hasta su port (los paneles degradan — probado por el smoke de tabs) |

## Ejemplo de split (Caddy)

```caddy
janusly.example.com {
  # Fase 4-5: lo aún-Node primero (first-match-wins).
  @node path /ai/explain-run /ai/explain-workflow /ai/review-workflow \
             /ai/suggest-improvement /ai/health /billing/* /causal \
             /runs/replay-lab* /organizations /users/me /plugins/install \
             /auth/invitations/accept
  reverse_proxy @node node-api:3001

  # Todo lo demás ya corre en Go.
  reverse_proxy go-api:4600
}
```

nginx equivalente: bloques `location` exactos para la lista @node con
`proxy_pass http://node-api`, y `location /` → `proxy_pass http://go-api`.
Rollback de una familia = mover su matcher de vuelta al upstream Node y
recargar el proxy; no hay estado que migrar.

## Divergencias esperadas (anotadas también en run-dual.mjs)

| Divergencia | Razón | Destino |
| --- | --- | --- |
| `run.traceId` null en Go | el pilot no puebla trace ids OTel en runs | wiring OTel del cutover |
| Granularidad del event-stream (Node emite `node.queued`/`node.started` por nodo; Go menos filas) | modelo de emisión del engine | alinear antes del cutover del timeline de Activity (fase 1 no lo bloquea: el web deriva estado de `nodes`, los eventos son detalle) |
| `runCount`/`lastRunStatus` del listado/trash | convención pilot: runs sin pin llevan `workflow_version_id = workflowId`; Node solo cuenta runs con fila de versión | resolver version-id real en `/start` de guardados (pre-requisito de la familia Flows) |
| `source: env` en 4 claves http/subworkflow de `/org/config` | artefacto del reference (`applyOrgConfigToEnv` muta `process.env` y el resolver se auto-reporta env) | el `default` de Go es el honesto; no se replica |
| `errorJson.name` (`TypeError` vs `Error`) | taxonomía de clases de error por runtime | normalizado como prosa; los `code`/status se comparan verbatim |

## Cómo re-correr la evidencia

```bash
node go/conformance/run-reference-stack.mjs node go/conformance/run-dual.mjs
```

El comparador falla (exit 1) ante CUALQUIER diff fuera de la lista
anotada — es el gate de regresión del strangler.
