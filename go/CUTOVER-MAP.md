# Mapa de cutover por ruta — strangler Node → Go

Fecha: 2026-08-02 (T-184 ola 6; actualizado al cierre de la ola 7) ·
Evidencia ejecutable:
`node go/conformance/run-reference-stack.mjs node go/conformance/run-dual.mjs`
(**27/27 casos idénticos tras normalización**, divergencias esperadas
anotadas abajo), `make parity` (F01.. semánticos), `make verify`
(escalera completa), smoke Playwright de 15 tabs, chaos de Postgres ×3
(`make chaos`), kill-failover ×3, bench hostil (`make bench-hostile`),
soak 24h estable (SOAK.md, anexo T-510), y las suites de integración
por módulo.

## Principio

El proxy corta POR FAMILIA DE RUTA, no por servicio. Cada familia migra
cuando su evidencia está verde; el rollback es apuntar la familia de
vuelta a Node (el estado vive en el MISMO Postgres — no hay migración de
datos en el switch). Dirección estratégica 2026-07-31: **ninguna familia
tiene exclusión permanente** — toda ruta tiene fase, no "si".

## Fases — estado real al cierre de la ola 7

**Las 5 fases tienen evidencia verde.** Todo el tráfico puede cortarse a
Go; Node queda como destino de rollback por familia, no como upstream
requerido por ninguna ruta.

| Fase | Familias | Estado de evidencia |
| --- | --- | --- |
| **1 — núcleo de ejecución** | `/workflows/*` (save/rollback/versions/latest/trash/restore/readiness/validate), `/start` `/resume` `/run*` `/runs*` (+ `/v1` reads), `/dlq*` completo, webhooks firmados (`/webhooks/*`), triggers (`/v1/triggers/*`), `/auth/context`, `/org/config`, `/health` | **lista** — dual 27/27 + paridad semántica + smokes + chaos ×3 + failover ×3 |
| **2 — operación y recuperación** | `/recovery/*` (home/items/metrics/campaigns/playbooks/feedback/calibration-status/drills **+ cases/ledger/my-wins**, ola 7 T-518), `/alerts/*`, `/auto-healing/*` (**+ propuestas LLM** T-515), `/upstream/*`, `/reports/run-explain`, `/system/*`, `/audit`, `/causal` (T-520), `/runs/replay-lab*` (T-517), `/runs/compare` | **lista** — suites por módulo + smoke Activity/Operations + bench hostil acotado <2× |
| **3 — administración** | `/members*`, `/org/roles*`, `/org/permissions/*`, `/org/scim/*` (+ webhook WorkOS, **endurecido por la property T-534**), `/credentials*`, `/mcp/*`, `/integrations/*`, `/eval/*`, `/experiments*`, `/snippets*`, `/solution-packs*`, `/templates`, `/tools`, `/onboarding`, `/workflows/health*`, metadata/tags/folders, **identidad restante** (`/organizations`, `/users/me`, `/auth/invitations/accept`, `/plugins/install` — T-519) | **lista** — suites verdes; SCIM además con 200 secuencias property + fixtures WorkOS; matriz authz central fail-closed |
| **4 — superficies AI** | `/ai/generate-workflow`, `/ai/patch-workflow`, **`/ai/explain-run`, `/ai/explain-workflow`, `/ai/review-workflow`, `/ai/suggest-improvement`, `/ai/health`** (portadas en ola 7 T-514) | **lista** — contrato AI-fallback $0 probado en las 7 rutas; budget compuesto org→workflow (T-516) |
| **5 — colas del cutover total** | `/billing/*` + `POST /workflows/{id}/budget` (T-516) | **lista** — shapes vs reference + gate compuesto probado |

> Historial: en el corte de la ola 6 (2026-08-01) las fases 4-5 decían
> "Node hasta portarlas". La ola 7 (T-514..T-521) portó todas esas
> familias; las filas de arriba reflejan el estado real.

## Ejemplo de split (Caddy)

Con las 5 fases verdes el split estable es "todo a Go":

```caddy
janusly.example.com {
  reverse_proxy go-api:4600
}
```

Durante la transición gradual (una familia a la vez), el patrón es el
matcher `@node` con SOLO las familias aún no cortadas — first-match-wins:

```caddy
janusly.example.com {
  # Ejemplo: aún no cortaste billing ni las AI nuevas.
  @node path /billing/* /ai/explain-run /ai/review-workflow
  reverse_proxy @node node-api:3001
  reverse_proxy go-api:4600
}
```

nginx equivalente: bloques `location` exactos para la lista @node con
`proxy_pass http://node-api`, y `location /` → `proxy_pass http://go-api`.
Rollback de una familia = mover su matcher de vuelta al upstream Node y
recargar el proxy; no hay estado que migrar.

## Divergencias esperadas (anotadas también en run-dual.mjs)

Quedan DOS clases, ambas deliberadas del lado honesto:

| Divergencia | Razón | Postura |
| --- | --- | --- |
| `source: env` en 4 claves http/subworkflow de `/org/config` | artefacto del reference (`applyOrgConfigToEnv` muta `process.env` y el resolver se auto-reporta env) | el `default` de Go es el honesto; no se replica |
| `errorJson.name` (`TypeError` vs `Error`) | taxonomía de clases de error por runtime | normalizado como prosa por el comparador; los `code`/status se comparan verbatim |

Resueltas durante la ola 7 (ya NO están en la lista esperada):
`run.traceId` (T-504: correlación heredable + spans OTel), granularidad
del event-stream (T-505: `node.queued`/`node.running` con el vocabulario
del reference), y `runCount`/`lastRunStatus` (T-500: semántica de
version-id real).

## Cómo re-correr la evidencia

```bash
node go/conformance/run-reference-stack.mjs node go/conformance/run-dual.mjs
```

El comparador falla (exit 1) ante CUALQUIER diff fuera de la lista
anotada — es el gate de regresión del strangler. La escalera local
completa es `make verify` (generate+drift → build → lint → unit →
integration → parity, ~4.5 min).
