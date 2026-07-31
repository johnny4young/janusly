# `go-pilot` v4 — plan ejecutable

**v4 (2026-07-30, directivas de Johnny):**

1. **Base de análisis y estrategia: la rama `develop`** (más avanzada que
   main). La rama del piloto fue re-basada sobre `develop @ c1aa11e2`
   (71 tablas / 29 migraciones aplicadas a `janusly_go`). Johnny la
   modificará hoy; el protocolo de seguimiento desde ahora: la revisión
   intensiva quedó hecha sobre esta base y, en adelante, **solo se revisan
   los diffs de commits posteriores** (`git log <pin>..develop` antes de
   cada tanda de paridad, actualizando el pin en §9).
2. **Alcance final del piloto: Backend + UI.** Al terminar, la web React debe
   funcionar contra el backend Go **exactamente como funciona hoy contra
   Node, sin excepciones**. El detalle está en §10–§11; el timebox de 3
   semanas cubre la Fase 0 (motor) y su puerta D15 decide la continuación
   de las fases F1–F3.
3. **Los comentarios del código jamás referencian nombres internos del plan**
   (IDs `T-xxx`, secciones de PLAN.md): el código se explica por sí mismo
   (regla 10 del protocolo). Aplica también a mensajes de commit futuros.

Historial: v1 strangler (descartada) · v2 migración total + motor propio ·
v2.1 recovery core / MCP complemento / tests por tanda · v3 ejecutable ·
**v4 base develop + alcance Backend+UI**.

**Fuente de verdad durante la ejecución:** este archivo (`go/PLAN.md` en la
rama); los estados viajan en cada commit. La copia en docs/proposals del
checkout principal es el espécimen histórico.

---

## 0. Protocolo de ejecución autónoma (reglas de Johnny, 2026-07-30)

1. Tomar siempre la **primera tarea `todo` no bloqueada** en orden de ID.
2. Al empezar: estado → `partial` en `go/PLAN.md`.
3. Implementar según la especificación. Si la especificación choca con la
   realidad (columna que no existe, semántica distinta en Node), **se corrige
   el plan en el mismo commit** y se anota en §9 (Registro de decisiones).
4. Terminada la implementación: `make lint && make test` verdes (tests con
   `-race`) y TODOS los criterios de aceptación marcados.
5. Estado → `done`, commit con el mensaje definido en la tarea (Conventional
   Commits, **sin trailers de IA** — regla global de Johnny).
6. **Después de cada commit y antes de la siguiente tarea: resumen en el
   chat** — qué se hizo, qué cambió o mejoró a nivel de features, notas
   relevantes. **Nada requiere aprobación; se continúa iterando.**
7. Mejora descubierta en el camino: si es pequeña (≤~30 min) y sirve a la
   tarea en curso → se implementa y se anota; si es mayor → nueva fila
   `T-1xx` al final de la tabla con prioridad y estado `todo`.
8. Bloqueo real → estado `blocked` + nota de causa + se salta a la siguiente
   tarea no bloqueada. Un `blocked` sin salida al final del día se reporta en
   el resumen.
9. Push de la rama: opcional y agrupado (repo privado); nunca a `main`.
10. **Comentarios de código sin naming interno del plan** (ni `T-xxx` ni
    referencias a PLAN.md): un comentario explica el código para su próximo
    lector, no el proceso que lo produjo.
11. **"Sync develop" a demanda**: cuando Johnny lo pida (o antes de cada
    tanda de paridad), se ejecuta el procedimiento de sincronización:
    diff-review (`git log <pin>..develop`), rebase de la rama (sin
    conflictos por construcción: todo vive bajo `go/`), re-migrar si hay
    migraciones nuevas, actualizar el pin en §9 y re-verificar el
    inventario §11. No hace falta esperar a que develop "se calme"; la
    única cortesía útil es avisar antes de cambiar semántica del engine que
    una tarea esté portando en ese momento.

## 1. Decisiones cerradas

### 1.1 Puertos (regla: distintos a Janusly Node y fuera de 3000–3010)

| Servicio | Puerto | Nota |
| --- | --- | --- |
| API Go | **4600** | `JANUSLY_GO_PORT` |
| Interno (metrics Prometheus + pprof) | **4601** | `JANUSLY_GO_INTERNAL_PORT`; nunca público |
| PostgreSQL del piloto (Compose propio) | **4632** | mapea a 5432 interno; DB `janusly_go` |

Sin Redis. Sin colisión con: Node (3000/3001/9464/9465), stack local
(7310/7311/7431/7432), Vite (5173), ni servicios comunes (5432/6379/8080).

### 1.2 Stack (versiones verificadas por búsqueda 2026-07-30)

Go **1.26.5** · pgx **v5.10.0** + pgxpool · sqlc **1.31.1** · oapi-codegen
**v2.8.0** (OpenAPI 3.1, solo tipos) · golangci-lint **v2.12.2** · k6
**v2.1.0** · `net/http` stdlib + `log/slog` · SDK Go oficial de MCP ·
`prometheus/client_golang` · `net/http/pprof`.

### 1.3 Cola: propia sobre Postgres (sin BullMQ, River ni Asynq)

- **¿Existe "BullMQ para Go"?** Compatible, NO: BullMQ solo tiene clientes
  oficiales Node y Python; nada en Go habla su protocolo Redis. Equivalente
  (mismo espíritu, protocolo distinto): **Asynq** — mantenido (release
  feb-2026), retries/scheduled/unique tasks. Queda como plan C solo si un
  dato medido exigiera Redis-como-cola.
- **Modelo elegido** (fiel al modelo Node, sin intermediario):
  - `startRun` marca los nodos raíz `queued` en la MISMA transacción del
    insert de run + run_nodes + evento.
  - Al completar un nodo, el manejador calcula los sucesores listos EN
    CÓDIGO (el DAG vive en el snapshot `runs.input_json.workflow`, no en
    tablas) y los transiciona `pending→queued` con UPDATE condicional
    (`WHERE status='pending'` — el análogo del `tryClaimNodeForQueue`).
  - Los workers reclaman: `UPDATE run_nodes SET status='running' WHERE id IN
    (SELECT … WHERE status='queued' … FOR UPDATE SKIP LOCKED LIMIT $n)
    RETURNING …`.
  - `NOTIFY janusly_go_wake` (payload: solo `run_id`) al encolar; los
    workers escuchan LISTEN + ticker de respaldo (`JANUSLY_GO_POLL_MS`,
    defecto 250).
  - Timers (retry backoff, wait_until): tabla auxiliar del piloto (§1.5).

### 1.4 SDK de IA en Go (investigado; decisión para POST-piloto — el
pipeline de IA está fuera del alcance del piloto)

| Opción | Lectura |
| --- | --- |
| LangChainGo | Más proveedores, pero 170+ dependencias y modelo mental LangChain; mantenimiento comunitario desigual |
| Eino (ByteDance/CloudWeGo) | Muy activo, grado producción, 37 deps — pero es un FRAMEWORK de orquestación de agentes: se solapa con el engine de Janusly, que ES nuestro producto |
| Genkit Go (Google) | API unificada multi-proveedor, 129 deps, gravita hacia su ecosistema |
| GoAI y similares | 22+ proveedores con 2 deps — jóvenes, mantenedor único: riesgo |
| SDKs oficiales (anthropic-sdk-go, openai-go) | Primera parte, mantenimiento garantizado, sin abstracción multi-proveedor |

**Decisión: portar el patrón de la casa** — interfaz propia `LlmClient`
(chokepoint delgado, como `packages/ai/src/llm-client.ts` hoy sobre el
Vercel AI SDK) sobre los **SDKs oficiales** anthropic-sdk-go + openai-go.
Sin matrimonio con Anthropic (el proveedor es un adaptador), sin adoptar un
framework que compita con nuestro engine, y con la puerta que pidió Johnny:
si la capa crece bien, **se extrae como repo público open source**
(la abstracción multi-proveedor delgada y bien probada es exactamente el
tipo de pieza extraíble). Plan B: Eino, si algún día se quisiera amplitud de
proveedores inmediata.

### 1.5 Cambios de esquema: regla estricta

El piloto usa las MISMAS migraciones del repo sobre `janusly_go`. Si necesita
columnas/tablas propias (p. ej. despertadores), **jamás** altera tablas
compartidas: crea tablas `go_pilot_*` en una migración SQL propia
(`go/migrations/`) aplicada solo a `janusly_go`. Prevista:
`go_pilot_wakeups(run_node_id text primary key, wake_at timestamptz not
null, reason text not null)` — T-002 confirma contra el esquema real si
alguna columna existente ya sirve y lo anota en §9.

### 1.6 PDF en Go (investigado; post-piloto — `pdf.generate` fuera del
alcance)

Estado del mercado: `jung-kurt/gofpdf` archivado (2021); `go-pdf/fpdf`
archivado (2025); mantenidos: **maroto v2** (declarativo, estilo grid — el
más cercano al enfoque de plantillas de `pdf.generate`; apoyado sobre el
gofpdf archivado, matiz conocido), `signintech/gopdf` (bajo nivel), `gpdf`
(nuevo, puro Go, 0 deps — prometedor pero joven; su benchmark es marketing
propio). **Decisión diferida** con orden de evaluación: maroto v2 →
gopdf → gpdf; `chromedp` si algún día se exige fidelidad HTML.

### 1.7 Contrato y web

D1 OpenAPI-first (oapi-codegen sobre `apps/api/openapi.v1.json`); no hay
tRPC que reemplazar (stub borrado; AGENTS.md lo prohíbe). El binario final
podrá **incrustar el frontend con `embed.FS`**: la directiva `//go:embed`
de Go mete el `dist/` compilado de React DENTRO del ejecutable — un solo
archivo contiene backend + frontend; el usuario descarga un binario, lo
ejecuta y abre el navegador, sin Node, sin pnpm, sin Docker. Esa es "la
historia self-host CE". En el piloto: fuera de alcance (anotado como
`T-104`).

## 2. Tabla de seguimiento

Estados: `todo` · `partial` · `done` · `blocked`. Prioridad: P0 (ruta
crítica) · P1 (importante) · P2 (stretch).

| ID | Tarea | Prio | Estado |
| --- | --- | --- | --- |
| T-000 | Bootstrap: worktree, rama, scaffold, Compose 4632, migraciones | P0 | done |
| T-001 | Config, boot, observabilidad (4600/4601, slog, healthz, probe) | P0 | done |
| T-002 | sqlc + inventario real del esquema + persistencia núcleo | P0 | done |
| T-003 | Dominio: parsing + validación subconjunto (códigos de issue) | P0 | partial |
| T-004 | startRun transaccional + defaults de inputs | P0 | partial |
| T-005 | Cola propia: claim loop, worker pool, LISTEN/NOTIFY | P0 | done |
| T-006 | Gramáticas subconjunto: templates + expresiones | P0 | done |
| T-007 | Executors: noop, transform, condition + semántica de aristas | P0 | done |
| T-008 | Modelo de fallo: retry ladder + dead_letters | P0 | done |
| T-009 | wait_until + approval/waiting + POST /resume | P0 | done |
| T-010 | Redrive desde dead_letters | P0 | done |
| T-011 | Executor http + SSRF/DNS pinning | P0 | done |
| T-012 | API /v1 mínima + envelopes + goldens de referencia Node | P0 | todo |
| T-013 | Arnés de paridad semántica (lane A, fixtures F01–F10) | P0 | todo |
| T-014 | E2E de API Go (lane B) | P0 | todo |
| T-015 | Servidor MCP stdio + e2e vía MCP (lane C) | P1 | todo |
| T-016 | Rendimiento: k6 + RSS + pprof vs Node | P1 | todo |
| T-017 | Journal consolidado + análisis de fricción | P1 | todo |
| T-018 | Puerta D15: informe + recomendación | P0 | todo |
| T-101 | (stretch) Tick de schedules con líder por advisory lock | P2 | todo |
| T-102 | (post-piloto) LlmClient Go sobre SDKs oficiales | P2 | todo |
| T-103 | (post-piloto) pdf.generate: evaluación maroto v2 | P2 | todo |
| T-104 | (F3) embed.FS con el dist del web | P2 | todo |
| T-200 | (F1) auth/context + sesión + permisos por pestaña | P0 | todo |
| T-201 | (F1) catálogos: tools/templates/solution-packs/snippets/prompts | P0 | todo |
| T-202 | (F1) workflows: CRUD/versions/metadata/tags/folders/health | P0 | todo |
| T-203 | (F1) runs: list/detail/status/usage + SSE stream | P0 | todo |
| T-204 | (F1) Recovery Center lecturas: home/metrics/items/dlq/heatmap/calibración | P0 | todo |
| T-205 | (F1) credentials(+health)/members/roles/org-config/billing/onboarding/audit/system | P0 | todo |
| T-206 | (F1) hito: la web arranca contra Go y navega sus pestañas de lectura | P0 | todo |
| T-300 | (F2) escrituras DLQ/campañas/playbooks/feedback/auto-healing/alerts | P0 | todo |
| T-301 | (F2) AI surfaces completas con contrato AI-fallback | P0 | todo |
| T-302 | (F2) triggers/webhooks firmados + scheduler + crons system | P0 | todo |
| T-303 | (F2) los 26 tipos de nodo + gramáticas completas (paridad total) | P0 | todo |
| T-304 | (F2) Secret Store/HMAC/memoria/MCP/SCIM/rate limits/i18n server-events/permisos completos | P0 | todo |
| T-305 | (F2) rollouts canary + import packs + upstream + experiments | P1 | todo |
| T-400 | (F3) Playwright completo + browser + perf budgets verdes contra Go | P0 | todo |
| T-401 | (F3) saldo de diferidos §9 + plan de corte y reversa | P0 | todo |

## 3. Convenciones transversales (aplican a TODAS las tareas)

- **Módulo:** `github.com/johnny4young/janusly/go` (dir `go/` de la rama).
- **Layout:** `cmd/api`, `cmd/mcp`, `internal/{boot,config,httpapi,domain,
  engine,store,grammar,executors,conformance}`.
- **Errores:** valores centinela por dominio (`internal/domain/errors.go`),
  envueltos con `%w`; jamás strings sueltos comparados.
- **Inyección:** interfaces pequeñas definidas EN EL CONSUMIDOR (`Clock`,
  `Resolver`, `Store`) — el patrón de arneses que pide Johnny: todo lo no
  determinista (reloj, DNS, aleatorio) entra por interfaz para poder
  probarse. `internal/testclock` provee el fake.
- **Tests:** archivo `_test.go` junto a cada módulo; table-driven; los de
  integración llevan build tag `//go:build integration` y usan
  `JANUSLY_GO_DATABASE_URL`; `make test` = unit+integration con `-race`.
- **Nada de dependencias nuevas** sin fila en §9 con justificación.
- **jsonb crudo:** columnas jsonb viajan como `json.RawMessage` de la DB al
  wire sin re-serializar.
- **Tenancy:** todo acceso lleva `org_id`; el middleware dev-headers
  (`x-org-id`, `x-user-id`) es la única auth del piloto.

## 4. Tareas — semana 1 (motor)

### T-000 · Bootstrap (D1) — P0

**Objetivo:** worktree + rama + esqueleto compilable + DB propia migrada.
**Entregables:** worktree `../janusly-go-pilot` con rama `go-pilot` desde
`main`; `go/` con `go.mod` (go 1.26, `toolchain go1.26.5`), `Makefile`
(`db-up`, `db-down`, `migrate`, `generate`, `lint`, `test`, `run`, `parity`),
`.golangci.yml`, `go/docker-compose.yml` (pgvector/pgvector:pg18, puerto
4632, DB `janusly_go`, usuario/clave `janusly`, volumen nombrado
`janusly_go_pgdata`), `go/PLAN.md` (copia de este documento),
`cmd/api/main.go` mínimo que imprime versión y sale.
**Especificación:** las migraciones se aplican con el tooling existente
desde el worktree: `pnpm install` una vez y
`DATABASE_URL=postgres://janusly:janusly@127.0.0.1:4632/janusly_go pnpm
migrate` (conserva el journal `drizzle.__drizzle_migrations` que el probe de
T-001 exige). `make migrate` envuelve ese comando.
**Aceptación:** [ ] `make db-up && make migrate` deja las tablas del esquema (62 en la base congelada) y el
journal poblado (verificado con psql) · [ ] `go build ./...` y
`make lint` limpios · [ ] smoke test `TestSmokeBuild` pasa · [ ] compose no
colisiona con el stack Node corriendo a la vez.
**Tests:** `go/internal/boot/smoke_test.go:TestSmokeBuild` (trivial,
establece el arnés).
**Commit:** `feat(pilot): bootstrap Go module, compose and migrations`

### T-001 · Config + boot + observabilidad (D2 mañana) — P0

**Objetivo:** proceso arrancable con configuración validada y telemetría.
**Especificación:** `internal/config` lee `JANUSLY_GO_DATABASE_URL`,
`JANUSLY_GO_PORT` (4600), `JANUSLY_GO_INTERNAL_PORT` (4601),
`JANUSLY_GO_WORKER_CONCURRENCY` (8), `JANUSLY_GO_POLL_MS` (250),
`JANUSLY_GO_HTTP_TIMEOUT_MS` (30000) — todo con defecto y validación de
rango; error de config = salida con mensaje claro, nunca pánico.
`internal/boot`: pgxpool (max 10), **probe de migraciones** (falla rápido si
`drizzle.__drizzle_migrations` no existe o está vacía — espejo de
`assertMigrationsApplied`), slog JSON a stdout. Servidor interno 4601:
`/metrics` (promhttp) + `/debug/pprof/*`. Servidor 4600: `GET /healthz` →
`{"ok":true}`.
**Aceptación:** [ ] arranca contra la DB migrada y sirve /healthz ·
[ ] falla rápido con DB sin migrar (mensaje nombra el probe) · [ ] /metrics
expone `go_goroutines` · [ ] config inválida rechazada con rango en el
mensaje.
**Tests:** `config_test.go` (tabla: defectos, rangos, inválidos),
`boot_integration_test.go` (probe contra DB real: migrada ok / vacía falla).
**Commit:** `feat(pilot): config, boot probe and observability endpoints`

### T-002 · sqlc + inventario del esquema + persistencia núcleo (D2 tarde–D3 mañana) — P0

**Objetivo:** acceso tipado a `runs`, `run_nodes`, `run_events`,
`dead_letters`, `workflows`, `workflow_versions`.
**Especificación:** PRIMERO inventariar el esquema real (leer
`packages/db/src/schema.ts` + `\d` en psql) y anotar en §9 el mapa de
columnas que el piloto usa — aquí se decide si `go_pilot_wakeups` (§1.5) es
necesaria y se crea `go/migrations/0001_go_pilot.sql`. `sqlc.yaml` con
esquema vía `pg_dump --schema-only` regenerable (`make schema-dump`) — vía
elegida por robustez frente a los comentarios breakpoint de drizzle; si el
glob de migraciones funciona, cambiarlo y anotarlo. Consultas en
`internal/store/queries.sql`: insert run/run_nodes batch/evento; select run
por id+org; lista runs keyset `(created_at,id)` cap 100/200; eventos por run
keyset `(created_at,id)` cap 200/500; transiciones de run_nodes (UPDATE
condicionales por status — los CAS); insert/select/claim dead_letters;
workflows CRUD de lectura + `deleted_at IS NULL`.
**Aceptación:** [ ] `make generate` reproducible sin diff · [ ] round-trip
de integración para cada tabla · [ ] keyset estable ante empates de
timestamp (desempate por id, igual que Node).
**Tests:** `store_integration_test.go` (round-trips, keyset con empates,
CAS de transición rechaza estado equivocado).
**Commit:** `feat(pilot): typed persistence layer over the shared schema`

### T-003 · Dominio: parsing + validación subconjunto (D3 tarde) — P0

**Objetivo:** cargar workflow JSON al modelo Go con validación fiel.
**Especificación:** `internal/domain`: structs Workflow/Node/Edge/Inputs
(json tags exactos al wire Node). Tipos de nodo aceptados por el piloto:
`noop, transform, condition, http, wait_until, approval`; cualquier otro →
issue `node_type_unsupported_pilot` (código PROPIO documentado — divergencia
deliberada). Validación portada con los MISMOS códigos que Node donde
aplique: `edge_invalid_from`, `edge_invalid_to`, `cycle_detected`,
`missing_start_node`, `edge_invalid_condition` (la gramática de T-006
valida), `input_default_type_mismatch`. Fuente de la semántica:
`packages/engine/src/workflow-validation.ts` (leer antes de portar; los
tests TS son la especificación).
**Aceptación:** [ ] fixtures válidas de `docs/workflows.md` §2 y §6 parsean
· [ ] ciclo detectado · [ ] códigos idénticos a Node en el subconjunto.
**Tests:** `domain_test.go` table-driven (≥12 casos, incluidos los portados
de `workflow-validation` TS con cita del caso origen en comentario).
**Commit:** `feat(pilot): workflow domain model and subset validation`

### T-004 · startRun transaccional + defaults (D4 mañana) — P0

**Objetivo:** el invariante de la casa en Go.
**Especificación:** `internal/engine/start.go`: UNA transacción que inserta
`runs` (con snapshot del workflow en `input_json.workflow` y el input
RESUELTO en `input_json.input`), todos los `run_nodes` (raíces →
`queued`, resto `pending`), y el evento `run.started`; NOTIFY al confirmar.
Puerto de `applyInputDefaults` + `validateInputs` (subconjunto de tipos
primitivos + object plano; fuente: `packages/engine/src/inputs-validator.ts`
— sus tests TS son la especificación, incluido el caso trigger-style).
**Aceptación:** [ ] fallo inyectado a mitad de tx no deja NINGUNA fila ·
[ ] payload estilo trigger satisface requeridos con defaults (paridad con el
caso TS) · [ ] `null`/`false` explícitos ganan al default.
**Tests:** `start_integration_test.go` (atomicidad con store que falla en el
tercer insert), `defaults_test.go` (tabla portada de
`inputs-validator.test.ts`).
**Commit:** `feat(pilot): transactional run start with input defaults`

### T-005 · Cola propia (D4 tarde–D5) — P0

**Objetivo:** el corazón concurrente, verificado con `-race`.
**Especificación:** según §1.3. `internal/engine/queue.go`: `Claim(ctx, n)`
(SKIP LOCKED sobre `queued`, transición a `running` con `started_at`),
`CompleteNode` (en UNA tx: estado del nodo + persistir output en
`state_json` vía el equivalente de safe-persist acotado a 256 KB con
centinela `__truncated` + calcular sucesores listos del DAG en código +
`pending→queued` condicional + NOTIFY + evento `node.succeeded`), worker
pool de N goroutines con LISTEN + ticker de respaldo; apagado limpio por
contexto (drain: termina lo reclamado, no reclama más).
**Aceptación:** [ ] con 8 workers y un DAG de 50 nodos ningún nodo se
ejecuta dos veces (contador atómico en executor de prueba) · [ ] diamante
(fan-out/fan-in) respeta ALL-AND: el join corre UNA vez y después de ambas
ramas · [ ] SIGTERM drena sin dejar `running` huérfanos · [ ] `-race`
limpio.
**Tests:** `queue_race_integration_test.go` (los tres escenarios de
aceptación como tests), `queue_test.go` (readiness en código: tabla de
DAGs).
**Commit:** `feat(pilot): postgres-native claim loop and worker pool`

## 5. Tareas — semana 2 (el loop de recovery completo)

### T-006 · Gramáticas subconjunto (D6 mañana) — P0

**Especificación:** `internal/grammar`. Templates: `{{context.<nodeId>.
output.<path>}}`, `{{context.input.<name>}}`, `{{inputs.<name>}}` (solo en
outputs de workflow), paths anidados con puntos; modo lenient: no resuelto →
cadena vacía (el evento `template.unresolved_path` queda ANOTADO como
divergencia aceptada del piloto, no implementado). Render sobre strings y
sobre mapas (mapping de transform). Expresiones (aristas y condition):
literales (bool/número/string entre comillas), paths `context.*`/`inputs.*`,
`===`, `!==`, `>`, `<`, `>=`, `<=`, `&&`, `||`, `!`, paréntesis. Fuente:
`packages/engine/src/template.ts` y `expression.ts` — SUS TESTS son la
especificación; portar los casos del subconjunto citando origen.
**Aceptación:** [ ] ≥25 casos portados de los tests TS pasan idénticos ·
[ ] expresión fuera de gramática → error de validación (nunca evaluación
parcial).
**Tests:** `template_test.go`, `expression_test.go` (table-driven, comentario
con el archivo:caso TS de origen).
**Commit:** `feat(pilot): template and expression grammar subset`

### T-007 · Executors base + semántica de aristas (D6 tarde) — P0

**Especificación:** `internal/executors`: interfaz
`Execute(ctx, node, runCtx) (output json.RawMessage, err error)`. `noop` →
`{}`; `transform` → mapping renderizado (mapping vacío = issue en
validación, paridad T-003); `condition` → `{"result": bool}`. Semántica de
aristas condicionales (fuente: `enqueueReadyNodes` en Node — LEER antes):
arista con condición falsa no habilita al sucesor; sucesor cuyas TODAS las
entradas quedaron inhabilitadas → estado `skipped` (propaga). Documentar en
§9 la semántica exacta observada en Node.
**Aceptación:** [ ] fixture rama true/false ejecuta solo la rama verdadera y
marca `skipped` la otra · [ ] outputs quedan en `state_json` y son
templateables aguas abajo.
**Tests:** `executors_test.go`, `edges_integration_test.go` (grafo de ramas).
**Commit:** `feat(pilot): base executors and conditional edge semantics`

### T-008 · Modelo de fallo: ladder + dead_letters (D7) — P0

**Especificación:** error del executor → `attempt+1`; si `attempt <
maxAttempts` (config del nodo `retry.maxAttempts`, defecto 1=sin retry) →
reprogramar vía `go_pilot_wakeups` con backoff exponencial
(base 2s, factor 2, jitter ±20%, tope 60s — Clock inyectado); agotado → nodo
`failed` + fila `dead_letters` (org, run, node, attempt, `error_json`,
`workflow_json`, `node_json` — snapshot exacto, misma forma que Node) + run
`failed` + evento `node.failed`. Éxito tras retry limpia el contador.
**Aceptación:** [ ] nodo que falla 2 veces y triunfa a la 3.ª termina
`succeeded` con `attempt=3` · [ ] agotado produce EXACTAMENTE una fila
dead_letters con los tres snapshots · [ ] backoff respeta el fake clock
(sin sleeps reales en tests).
**Tests:** `retry_test.go` (fake clock), `dlq_integration_test.go`.
**Commit:** `feat(pilot): retry ladder and dead letter capture`

### T-009 · wait_until + approval/resume (D8 mañana) — P0

**Especificación:** `wait_until` (config `{until: ISO}` o `{durationMs}`) →
estado `waiting` + wakeup; el ticker de vencidos lo completa. `approval`
(config `{message}`) → `waiting` sin wakeup; `POST /resume` (body
`{runId, nodeId, input?}`, dev-auth, org-scoped) completa SOLO un nodo aún
`waiting` (CAS) con `input` como output y encola descendientes — replays no
pueden doble-escribir (paridad con la regla de la casa). Los tokens HMAC de
`human_form` quedan FUERA (anotado: divergencia de alcance).
**Aceptación:** [ ] approval pausa el run (`running`+nodo `waiting`) y
resume lo completa end-to-end · [ ] doble resume → 409 · [ ] wait_until de
500ms (fake clock en unit, real acotado en integración) completa solo.
**Tests:** `waiting_integration_test.go` (flujo completo + doble-resume).
**Commit:** `feat(pilot): waiting state with approval resume and timers`

### T-010 · Redrive (D8 tarde) — P0

**Especificación:** `POST /dlq/redrive` body `{deadLetterId}`: reclama la
fila (CAS sobre `replay_claimed_at IS NULL` — misma columna que Node),
resetea el nodo fallido a `queued` con `attempt` preservado+1 y run
`running`, evento `node.redriven` (nombre propio del piloto, anotado). El
run revive y termina según el executor.
**Aceptación:** [ ] F04→F05: fallo permanente → redrive con executor ya
sano → run `succeeded` · [ ] doble redrive de la misma fila → 409 ·
[ ] redrive cross-org → 404.
**Tests:** `redrive_integration_test.go`.
**Commit:** `feat(pilot): dead letter redrive revives the run`

### T-011 · http executor + SSRF (D9) — P0

**Especificación:** config `{url, method?, headers?, timeoutMs?}`.
Validación de destino: esquema http/https, resolver DNS con `Resolver`
inyectable, rechazar loopback/privadas/link-local/metadata (169.254.169.254)
— tabla de clases portada de los tests de `http-policy.ts`; conectar
**a la IP validada** vía `DialContext` propio (pinning — la clase de bug
rebinding no puede ocurrir); redirects máx 5 revalidando cada salto; tope
respuesta 1 MB (cap con centinela truncado); resultado
`{statusCode, ok, body, json?}` — `json` solo si content-type declarado
application/json y ≤64 KiB (paridad Node). Fallo HTTP ≠ fallo de nodo solo
para status: el nodo falla en errores de red/timeout (paridad con el nodo
`http` de Node: status no-2xx SÍ es fallo — VERIFICAR en
`node-registry.ts` y anotar en §9 la semántica exacta).
**Aceptación:** [ ] matriz SSRF (≥10 casos) rechazada · [ ] rebinding
simulado (resolver que cambia entre validación y dial) NO conecta a la
privada · [ ] happy path contra `httptest.Server` con retry en 500.
**Tests:** `ssrf_test.go` (tabla + resolver fake), `http_executor_test.go`.
**Commit:** `feat(pilot): http executor with pinned-dial SSRF protection`

### T-012 · API /v1 mínima + goldens de referencia (D10) — P0

**Especificación:** rutas: `POST /v1/workflows/save` (valida→inserta
workflow+versión), `POST /v1/start` (por snapshot inline, como el contrato),
`GET /v1/run?runId=&eventsCursor=`, `GET /v1/status?runId=`, `GET /v1/runs`,
`POST /v1/resume`, `GET /v1/dlq`, `POST /v1/dlq/redrive`. Envelope y
X-Request-Id idénticos a Node: ANTES de implementar, capturar del stack Node
local las respuestas reales de las rutas equivalentes (script
`conformance/capture-node-goldens.mjs` ejecutado en el checkout principal)
y guardarlas en `conformance/goldens/node/*.json` como referencia de forma.
Tipos oapi-codegen donde el contrato los cubre (runs/status/start);
divergencias de forma inevitables (p. ej. `node.redriven`) → §9.
**Aceptación:** [ ] cada ruta con test de contrato (forma, códigos de error,
404 cross-org, cursores round-trip Node↔Go donde aplique) · [ ] goldens de
Node capturados y versionados en la rama.
**Tests:** `httpapi/contract_test.go` por ruta (httptest).
**Commit:** `feat(pilot): minimal v1 API with node-shape goldens`

## 6. Tareas — semana 3 (aceptación, complemento MCP, números, puerta)

### T-013 · Paridad semántica — lane A (D11) — P0

**Fixtures (F01–F10):** F01 lineal noop→transform · F02 rama condicional
(true y false) · F03 http 200→transform · F04 http 500 persistente →
dead_letters · F05 redrive de F04 con upstream sano → succeeded · F06
approval→resume→descendientes · F07 wait_until 1s · F08 payload
estilo-trigger + defaults requeridos · F09 diamante fan-out/fan-in · F10
template no resuelto en lenient. Cada una corre en Node (una vez, para
generar el golden con `conformance/gen-goldens.mjs` contra `pnpm dev` del
checkout principal) y en Go (cada `make parity`). Proyección comparada:
`{status final del run, por nodo: estado final + attempts, outputs del run,
nº filas dead_letters}`. Divergencia = fallo del arnés salvo entrada en la
tabla de divergencias aceptadas (§9).
**Aceptación:** [ ] F01–F10 en verde o divergencia documentada · [ ] `make
parity` reproducible.
**Commit:** `test(pilot): semantic parity harness against node goldens`

### T-014 · E2E de API Go — lane B (D12 mañana) — P0

**Especificación:** un test de integración que arranca el binario real
(puerto efímero) + DB y conduce por HTTP el ciclo del README: save → start
→ http falla → dlq → redrive → succeeded; y save → start → approval →
resume → outputs.
**Aceptación:** [ ] ambos ciclos verdes en CI local (`make test`).
**Commit:** `test(pilot): full lifecycle API e2e`

### T-015 · MCP stdio — lane C (D12 tarde–D13 mañana) — P1

**Especificación:** `cmd/mcp` con el SDK Go oficial: tools
`workflows.save`, `runs.start`, `runs.status`, `runs.inspect`, `dlq.list`,
`dlq.redrive` — capa delgada sobre `internal/engine` EN PROCESO (sin HTTP).
Resultados como JSON + `structuredContent`; errores esperados como
`isError:true` (paridad de postura con el mcp-server Node). E2E: cliente
del SDK en un test que ejecuta el ciclo fallo→redrive. Doc:
`go/README.md` con el snippet de `claude_desktop_config.json`.
**Aceptación:** [ ] e2e MCP verde · [ ] demo manual con Claude anotada en
el journal (captura o transcripción).
**Commit:** `feat(pilot): in-process MCP server over the engine`

### T-016 · Rendimiento (D13 tarde–D14 mañana) — P1

**Especificación:** k6 v2.1.0: escenarios (1) `POST /start` + poll status
de F01 (runs/s sostenidos), (2) `GET /runs` keyset caliente, (3) F09
(throughput de nodos). Cargas 10/50/200 VUs × 2 min contra Go (4600) y
contra Node dev (3001) con la MISMA semilla de datos. Registrar
p50/p95/p99, RPS, errores, RSS en reposo y pico (ps), y un perfil pprof del
escenario 3. Tablas al journal. Sin umbral pasa/no-pasa.
**Aceptación:** [ ] tablas completas Node vs Go en el journal · [ ] perfil
pprof guardado en la rama.
**Commit:** `test(pilot): load comparison and profiles`

### T-017 · Journal consolidado (D14 tarde) — P1

Consolidar `docs/proposals/20260730-go-pilot-journal.md`: fricciones con
ejemplos concretos (qué costó más/menos que TS), divergencias aceptadas,
mejoras T-1xx implementadas.
**Commit:** `docs(pilot): consolidated friction journal` (en la rama).

### T-018 · Puerta D15 — P0

Informe final con las 4 condiciones (§8) evaluadas + recomendación escrita
(continuar a rewrite por fases con plan, o detener y borrar). La decisión es
de Johnny; el informe la deja lista.

## 7. Definición de "terminado" por tarea

`make lint` limpio · `make test` verde con `-race` · criterios de aceptación
todos marcados · estado `done` en `go/PLAN.md` · commit hecho · resumen en
el chat publicado.

## 8. Puerta de decisión (D15)

1. F01–F10 sin divergencias no documentadas — incluido el loop de recovery
   (fallo→dlq→redrive→éxito) y waiting/resume.
2. Lanes B y C verdes; demo MCP operable desde Claude.
3. Números propios de rendimiento que le importen al producto.
4. Journal sin fricción prohibitiva (las gramáticas completas y las 271
   rutas son MÁS trabajo que esta vertical).
   El rewrite real además exige ≥2 criterios estratégicos de
   `20260729-go-migration-analysis.md` §7.

## 9. Registro de decisiones, divergencias e inconsistencias (vivo)

| Fecha | Tipo | Nota |
| --- | --- | --- |
| 2026-07-30 | decisión | Puertos 4600/4601/4632; sin Redis |
| 2026-07-30 | decisión | Cola propia (§1.3); Asynq plan C; River descartada |
| 2026-07-30 | decisión | IA post-piloto: LlmClient propio sobre SDKs oficiales (§1.4); posible extracción OSS futura |
| 2026-07-30 | decisión | PDF post-piloto: maroto v2 → gopdf → gpdf (§1.6) |
| 2026-07-30 | diferido a F2 | `template.unresolved_path` no se emite en F0 (obligatorio antes del switchover) |
| 2026-07-30 | diferido a F2 | tokens HMAC de human_form fuera de F0; resume autenticado (paridad total exigida en F2) |
| 2026-07-30 | diferido a F2 | `node_type_unsupported_pilot` solo existe en F0; F2 implementa los 26 tipos de nodo |
| 2026-07-30 | reemplazada | (v3) pin en main @ da51e5df — sustituido por la directiva v4: base `develop` |
| 2026-07-30 | reemplazada | (v3) "piloto sin UI" — sustituida por la directiva v4: Backend + UI sin excepciones (§10) |
| 2026-07-30 | decisión | Push de respaldo de la rama 1×/semana, sin PR (CI no corre en ramas laterales) |
| 2026-07-30 | decisión | Proyecto Compose `janusly-go-pilot` (sin colisión con el lock del Compose fijo); org del piloto `default` |
| 2026-07-30 | decisión | "D1–D15" = orden de tareas, no calendario; el timebox de 3 semanas es el límite exterior |
| 2026-07-30 | nota | Toolchain local ya trae Go 1.26.5 + golangci-lint 2.12.2 exactos; k6 se instala en T-016 (`brew install k6`) |
| 2026-07-30 | corrección | La base congelada da51e5df tiene 62 tablas (el conteo 71 venía de develop); aceptación de T-000 ajustada |
| 2026-07-30 | corrección | PG 18: el volumen Docker monta en /var/lib/postgresql (no .../data) — compose ajustado |
| 2026-07-30 | decisión (v4) | Rama re-basada sobre `develop @ c1aa11e2`; DB regenerada: 71 tablas / 29 migraciones; PIN de paridad = ese sha; seguimiento por diffs (`git log <pin>..develop`) |
| 2026-07-30 | decisión (v4) | Alcance final Backend+UI (§10); D15 sigue siendo la puerta de F0 |
| 2026-07-30 | decisión (v4) | Inventario UI: 108 rutas + SSE (§11), extraído del código web |
| 2026-07-30 | regla (v4) | Comentarios de código sin IDs de tareas ni referencias a PLAN.md; scrub aplicado al código existente |
| 2026-07-30 | pin actualizado | Diff-review nº1: develop c1aa11e2 → **0f294ad2** (5 commits: calificación local + human form web; sin migraciones; inventario UI intacto). Rebase limpio |
| 2026-07-30 | hallazgo paridad | `http.ts` endureció CORS (sin `*`/`"null"`; headers credenciados solo con Origin allowlisted) — F1 debe replicar esta semántica de headers |
| 2026-07-30 | mejora F3 | Los smokes de calificación nuevos (clean-install, upgrade-rollback, security, tenant-isolation, backup/restore) se suman a la aceptación del switchover: deben pasar con el backend Go |
| 2026-07-30 | decisión | Journal movido a `go/JOURNAL.md` (en la rama, visible para cualquier agente); el gitignored del checkout principal queda obsoleto |
| 2026-07-30 | decisión | Rama publicada en `origin/go-pilot` para acceso multi-agente (CI no corre en ramas laterales) |
| 2026-07-30 | inventario | Esquema real confirmado: `run_nodes.attempts` (plural), `dead_letters.status/attempt/replay_claimed_at`, `run_events.hold_until`; toda NOT NULL sin valor tiene default — inserts mínimos válidos |
| 2026-07-30 | decisión | `go_pilot_wakeups` confirmada necesaria (run_nodes no tiene columna de despertar); migración piloto 0001 aplicada solo a janusly_go |
| 2026-07-30 | decisión | sqlc como tool de go.mod (`go tool sqlc`) — pinneada 1.31.1, sin brew, agnóstica de máquina; esquema vía `make schema-dump` (pg_dump del contenedor) |
| 2026-07-30 | hallazgo | Postgres jsonb NORMALIZA al escribir (claves alfabéticas, espaciado canónico) — idéntico para Node; el passthrough RawMessage garantiza cero re-encodeo de Go encima, no des-normalización. La afirmación de §1.3/§3 queda precisada así |
| 2026-07-30 | gotcha sqlc | Overrides de timestamptz requieren AMBAS formas (`timestamptz` para parámetros y `pg_catalog.timestamptz` para columnas) |
| 2026-07-30 | hallazgo | Node YA tiene `unsupported_node_type` (tipo inválido en toda la plataforma); el código piloto cubre el caso distinto "válido en Node, no ejecutable en F0" — ambos coexisten |
| 2026-07-30 | divergencia aceptada (F2 revisa) | Mensajes de `invalid_contract`: paridad de código+path sí, redacción exacta de Zod no reproducible mecánicamente |
| 2026-07-30 | divergencia menor | Orden de issues dentro de properties: Go itera ordenado alfabético (mapas sin orden); Node usa orden de inserción — el arnés de paridad compara conjuntos |
| 2026-07-30 | decisión | Gramática de expresiones como seam inyectable (`ExpressionValidator`); permisiva hasta que la gramática real la reemplace |
| 2026-07-30 | paridad exacta | startRun: raíces `queued`+`attempts=1`+`state_json {}`, resto `pending`+0; evento `run.started` payload `{workflowVersionId}`; versionId = versionId ?? workflowId ?? runId (leído de start-run.ts:85,225-249) |
| 2026-07-30 | decisión | NOTIFY dentro de la transacción (pg entrega al commit) — el wake solo dispara si el commit ocurre; probado con LISTEN real |
| 2026-07-30 | decisión | Semántica undefined/null del JS portada como (value, present); nil en el tope = ausente; el engine normaliza input nil→{} como Node |
| 2026-07-30 | nota | Dep nueva: google/uuid (paridad de formato de ids con crypto.randomUUID) |
| 2026-07-30 | nota | El endurecimiento __proto__ que develop añadió a applyInputDefaults es gratis en Go (mapas sin prototipo) — test lo fija igual |
| 2026-07-30 | decisión | Completación de nodo bajo `pg_advisory_xact_lock(hash(run_id))`: las transacciones de completación del MISMO run se serializan (la ejecución sigue paralela), así el scan de readiness de un sibling siempre ve la completación anterior — el fan-in del join no necesita reconciler ni ventana de crash: completación + evento + queue de sucesores + rollup del run son UNA transacción |
| 2026-07-30 | divergencia | `queuePublicationGeneration`/`repairAfter` de Node no se portan: existen porque BullMQ es un segundo store que reconciliar; aquí la transición de fila ES la publicación |
| 2026-07-30 | paridad exacta | evento `node.succeeded`: output inline solo ≤ 8.000 bytes, si no `{outputBytes, outputTruncated, attempt}`; `state_json {output}` cap 1 MB con centinela `{__truncated, originalBytes, maxBytes, preview}` (preview = cap/2 bytes); `node.queued` payload `{}`; `run.failed`/`run.succeeded` con created_at +1 ms tras el evento causal (orden de keyset, detalle de dead-letter-queue.ts:182) |
| 2026-07-30 | divergencia temporal | `FailNode` mínimo pre-T-008: error_json `{message}`, sin fila `dead_letters` ni escalera de retries; flip de run solo desde `running` (waiting llega en T-009) |
| 2026-07-30 | nota | Proyección de `outputs` declarados al terminar el run se difiere a T-007 (necesita resolución de templates); output_json queda NULL igual que Node sin outputs declarados |
| 2026-07-30 | nota | Claim ordena por `rn.id` (run_nodes no tiene created_at); el orden del DAG domina de todos modos. Fallback de polling por worker (250 ms default) cubre NOTIFY perdidos y arranques en frío |
| 2026-07-30 | mejora sobre card | T-006 portó la gramática COMPLETA de expresiones (incluye `==`/`!=` laxos, `contains`/`startsWith`/`matches`/`in`, arrays, `null`), no solo el subconjunto listado — la card subestimaba; el evaluador canónico vive en `@janusly/shared/src/expression.ts` y sus tests son la spec |
| 2026-07-30 | hallazgo (referencia) | Verificado en vivo contra Node: `(A || B) && C` — un grupo booleano entre paréntesis compuesto con otro operador — está FUERA de la gramática de referencia (lanza `Unsupported expression token`); los paréntesis solo agrupan en el nivel externo o tras `!`. El port reproduce el rechazo idéntico, con test que lo fija |
| 2026-07-30 | decisión | Semántica JS explícita en `jsvalue.go`: undefined≠null, truthiness, `Number()` (hex/octal/binario/Infinity/cadena vacía→0), orden relacional de strings por unidades UTF-16 |
| 2026-07-30 | divergencia | Igualdad de referencias JS (`===` entre arrays/objetos) no reproducible tras round-trip JSON → operandos no escalares comparan false; `==` laxo con operando array/objeto → false (JS haría ToPrimitive); objetos interpolados en strings serializan con claves alfabéticas (Go) vs orden de inserción (JS); `String()` de magnitudes extremas puede diferir del shortest-round-trip de V8 |
| 2026-07-30 | divergencia | `unresolvedPaths` conserva dedupe pero no el orden de inserción exacto al iterar mapas Go (el test verifica pertenencia); `redactError` de Node (mutación de Error JS) no se porta — la redacción de errores se aplica como strings en T-008 |
| 2026-07-30 | nota | `parseSimpleComparisonExpression`/`formatSimpleComparisonExpression` (authoring guiado del web) se difieren a F1; lint: exclusión ST1005 por paquete — los mensajes capitalizados de referencia son contrato |
| 2026-07-30 | corrección a la card | T-007: la card decía que el skip "propaga" — FALSO en Node (runtime.ts:592-606): un predecesor `skipped` SATISFACE sus aristas salientes; el sucesor con arista sin condición EJECUTA (contra output vacío `{}`). El skip solo ocurre cuando todas las aristas entrantes satisfechas llevan condición falsa. Fixture lo fija |
| 2026-07-30 | paridad exacta | Scope de templates en nodo: `{context: <run context + input>, inputs: <config del PROPIO nodo>}` (execute-node.ts:196-199); aristas evalúan con `inputs: {}` VACÍO (runtime.ts:604) — una condición de arista no puede ver el run input (por eso existe el guard `edge_condition_inputs_scope`); entrada de contexto por nodo `{status, attempts, state, output, error}` con `output = state.output ?? {}` |
| 2026-07-30 | mejora sobre card | `template.unresolved_path` + `templatePolicy: "strict"` SÍ se implementaron (la card los anotaba como divergencia aceptada) — payload `{count, paths≤20, truncated, policy}` idéntico; y la proyección de `outputs` declarados (outputs-projector.ts: refs secret/env enmascaradas ANTES de renderizar) aterrizó aquí, cerrando la nota diferida de T-005 |
| 2026-07-30 | divergencia (superior) | El scan de readiness itera a punto fijo; Node hace UNA pasada en orden de declaración — un workflow donde el dependiente de un nodo skippeado aparece ANTES en `nodes[]` queda ATASCADO en Node (nada re-dispara el scan). Divergencia estrictamente superior; idéntico en workflows bien ordenados |
| 2026-07-30 | divergencia | Error al evaluar condición de arista → se trata como falsa (skip determinista); Node deja propagar el throw al job (retry BullMQ). Validación al guardar rechaza gramática inválida, así que solo drift de datos llega aquí |
| 2026-07-30 | bug corregido (port) | `Parse` dejaba `Nodes`/`Edges` nil con array vacío → el snapshot re-marshalado emitía `null` y fallaba su propio re-parse en el claim; ahora slices no-nil siempre — el snapshot round-tripea `[]` |
| 2026-07-30 | divergencia temporal | Sin validación Zod post-template por tipo de nodo (NODE_CONFIG_SCHEMAS) ni timeout por nodo (`config.timeoutMs` / withTimeout) — llegan con T-008/T-012 |
| 2026-07-30 | corrección a la card | T-008: los números de backoff de la card (base 2s, ±20%) eran inventados — la fuente (core/retry-policy.ts) usa base `delayMs ?? 1000`, exponencial `base*2^(attempt-1)` solo con `backoff:"exponential"`, tope `maxDelayMs`, y jitter FULL uniforme en `[delay/2, delay]`. Se portó la fuente |
| 2026-07-30 | paridad exacta | `shouldRetry` con clasificación de labels (name, code, status exacto, familia `Nxx`, `timeout` por wording/ETIMEDOUT/NODE_TIMEOUT, `network` por wording/ECONNRESET/ENOTFOUND); `ignoreOn` gana, `retryOn` vacío = retry a todo; sin política = sin retry. Evento `node.retry {attempt, delayMs, error}`; DLQ: workflow/node snapshots SIN truncar (replay exige el JSON exacto) pero SÍ key-redactados; error_json cap 64 KB; `node.failed {error, attempt}` con campos causales fijos |
| 2026-07-30 | decisión (elegante) | El retry diferido NO necesita un scheduler: el claim lleva un anti-join `NOT EXISTS (wakeup con wake_at > now())` — la fila es reclamable en el instante en que su reloj pasa, sin proceso intermedio. El sweeper de `go_pilot_wakeups` es solo GC + nudge de workers ociosos; la corrección jamás depende de él |
| 2026-07-30 | mejora sobre card | safe-persist completo: `safePersist` = redacción de claves sensibles (regex cerrado portado de sensitive-keys.ts) + acotado con centinela; aplicado a state_json, payloads de eventos, error_json y los tres JSON del DLQ (cap 0 = sin truncar). Cierra la divergencia de redacción por claves que venía anotada |
| 2026-07-30 | divergencia | Errores Go planos serializan `{message}` sin `name` (JS siempre lleva `name:"Error"`); `ExecError {message,name,code,statusCode}` lo aporta cuando el executor lo conoce (http en T-012). Tier transitorio (`decideTransient`) y guard write-side no portados aún — write-side llega con T-012 |
| 2026-07-30 | nota | Seams `now()`/`randFloat` en el Engine para tests deterministas del backoff; éxito tras retry conserva `attempts=N` como evidencia (igual que Node) |
| 2026-07-30 | corrección a la card | T-009: la card decía "resume con input como output" — Node NO hace eso para approval: `output = {}` SIEMPRE (histórico; la decisión vive en timeline+audit, no en el output — resume-run.ts:22-24). El input-como-output es solo webhook/human_form (fuera del subset). Portado Node-exacto |
| 2026-07-30 | corrección a la card | T-009: config de wait_until es `{duration: ISO-8601}` o `{until: instante ISO}` (waiting-time.ts), no `{durationMs}` como decía la card. Parser de duraciones portado (año=365d, mes=30d, decimales; P/PT desnudos = inválidos) + instante con timezone explícita y validación de campos (día imposible, bisiestos, offsets) |
| 2026-07-30 | paridad exacta | Checkpoint waiting: `state_json {waiting: {reason, ...metadata, waitingSince}}`; evento `node.waiting {status, reason, metadata}`; metadata timer `{kind:"timer", wakeAt, durationMs, source}`, approval `{kind:"approval", title (title||message), description?, assignee?, resumeToken:"runId:nodeId"}`; resume → `node.resumed {}`; instante pasado en `until` → delayMs 0 (resume inmediato, workflows guardados no rompen); conflicto de resume = "Node is not waiting" |
| 2026-07-30 | decisión | El timer reutiliza `go_pilot_wakeups`: el sweeper resuelve wakeups vencidos de nodos waiting vía `ResumeRun` (mismo camino que el resume manual — idéntico a Node donde handleWaitResume llama resumeRun); el CAS waiting→succeeded hace idempotente el disparo duplicado. SweepDueWakeups ya no borra wakeups de nodos waiting (solo GC de consumidos) |
| 2026-07-30 | decisión (postura pilot) | Approval con campos de deadline (`decisionTimeoutMs`/`until`/`onTimeout`/`escalateTo`) FALLA determinista con código `approval_deadline_unsupported_pilot` — ejecutarlo ignorando la supervisión declarada sería peor que fallar. Las políticas de deadline (arm/timeout/escalate de Node) quedan fuera del subset |
| 2026-07-30 | nota | ResumeRun es UNA transacción (CAS + borrar wakeup + evento + scheduleDownstream) — Node lo hace en 4 pasos separados; tokens HMAC de human_form fuera de alcance (anotado en card) |
| 2026-07-30 | decisión | Redrive = UNA transacción bajo el advisory lock del run: leer DL (org-scoped, cross-org = not-found indistinguible) → CAS `replay_claimed_at IS NULL` → failed→queued con attempts+1 → run failed→running → `node.redriven {deadLetterId, attempt}` → NOTIFY. Un crash no puede dejar un claim quemado sin nodo revivido |
| 2026-07-30 | paridad + divergencia anotada | La columna de claim es la misma de Node (`replay_claimed_at`); el evento `node.redriven` es nombre propio del piloto (anotado en card). `dead_letters.status` queda `open` — el flip a `replayed`/`replayedAt` es maquinaria de impacto de recuperación de Node (se marca al RECUPERAR, no al iniciar el replay: "replay initiation is never a recovered win") — diferido a F2 |
| 2026-07-30 | paridad (heredada) | Ni Node ni el piloto limpian `error_json` al completar un nodo redriveado — la evidencia del fallo anterior queda en la fila junto al output nuevo. Verificado en markNodeSucceeded (no toca errorJson) |
| 2026-07-30 | nota | Si el nodo ya no está `failed` (redrive previo, cancel), el claim NO se quema: la tx entera revierte y devuelve conflicto — el operador puede reintentar cuando el estado se aclare. La ruta HTTP `POST /dlq/redrive` monta en la tarea de API |
| 2026-07-30 | verificado en fuente | T-011: status no-2xx SÍ falla el nodo — `HttpResponseError {name:"HttpResponseError", code:"E_HTTP_STATUS", statusCode, message:"HTTP failed: N"}` (core/http-error.ts; existe precisamente para que `retryOn:["5xx"]` clasifique). El pipeline de dispatch preserva name/code/statusCode a través de la redacción — sin eso, la escalera de retries quedaría ciega para el tipo de nodo más común |
| 2026-07-30 | corrección a la card | El tope de respuesta LANZA error con los mensajes exactos de Node ("HTTP response exceeds maxResponseBytes…"), no centinela truncado — el centinela es del safe-persist, no del executor |
| 2026-07-30 | paridad exacta | Tabla de clases portada de http-policy.ts:194-238: IPv4 0/8, 10/8, 127/8, CGNAT 100.64/10, 169.254/16 (metadata incluida), 172.16/12, 192.168/16, ≥224; IPv6 ::1, ::, fc/fd, fe80, ff, mapeadas ::ffff:x; hostnames `localhost`/`localhost.localdomain`/`*.localhost`; mensajes de rechazo verbatim; bypass `ALLOW_PRIVATE_HTTP_TARGETS=true` SIN pinning (igual que Node: el bypass devuelve la URL sin agent); proyección JSON solo con media type declarado (`application/json` o `application/*+json`), ≤64 KiB, `jsonParseError`/`jsonParseSkipped:"body_too_large"`; defaults 30s/1MB/5 redirects |
| 2026-07-30 | decisión | Pinning por construcción: el resolver se consulta EXACTAMENTE una vez (validación) y `DialContext` marca la IP validada del mapa por host — el dial de un host no validado se rehúsa, y un pin privado se rehúsa en el socket (defensa en profundidad). Cada salto de redirect revalida y re-pinnea vía CheckRedirect |
| 2026-07-30 | divergencia temporal | Sin org_config (bounds por tenant), sin modo streaming (`bodyMode:"stream"`), sin dry-run/validation skip de métodos write-side, sin strip de headers con credenciales en redirect cross-origin — F2. El guard write-side de retries (no reintentar writes) llega cuando exista noción de validation runs |
| 2026-07-30 | watch-item | Flake 1/~10: TestDelayedRetryIsNotClaimableUntilDue falló una vez en suite completa (0.37s, detalle no capturado); pasa 6/6 después. Diagnosticar si recurre |
| — | — | (las siguientes filas se añaden durante la ejecución) |

## 10. Alcance final: Backend + UI, sin excepciones (v4)

La definición de "terminado" del piloto completo: **la web React actual,
sin modificar (salvo la URL del API), funciona contra el binario Go
exactamente igual que contra Node** — misma apariencia, mismos flujos,
mismos errores, mismo streaming. La aceptación final es la suite Playwright
completa + browser-mode + presupuestos de rendimiento, verdes contra Go.

### Fases

| Fase | Contenido | Horizonte |
| --- | --- | --- |
| **F0 — Motor (T-000…T-018)** | La vertical durable de recovery + puerta D15 | Timebox 3 semanas (vigente) |
| **F1 — La UI arranca y opera lecturas** | `auth/context` + sesión/organización; catálogos (`tools`, `templates`, `solution-packs`, `snippets`, `prompts`); workflows CRUD/versions/metadata/tags/folders/health; runs list/detail/status/usage + **SSE `/runs/:id/stream`** (fetch+ReadableStream, hub sobre LISTEN/NOTIFY); Recovery Center (`recovery/home`, `metrics`, `items`, `dlq/*` lecturas, heatmap, calibración); `credentials(+health)`, `members/roles`, `org/config`, `billing`, `onboarding`, `audit`, `health`/`system/*` | ~3–4 semanas post-gate |
| **F2 — Paridad operativa total** | Todas las escrituras y flujos: DLQ replay/bulk/clusters/validate-fix, campañas, playbooks, feedback, auto-healing, alerts, experiments/evals, AI surfaces completas (generate/explain/review/patch/suggest/explain-run **con el contrato AI-fallback**), triggers/webhooks (PagerDuty/Slack/external-runtime firmados), scheduler + 19 crons `system:`, rollouts canary, Secret Store (compatible bit a bit), resume tokens HMAC, memoria/vector, MCP cliente+servidor, SCIM/SSO, rate limiting, i18n de server-events, permisos (catálogo completo + roles custom), import de packs, upstream sources | ~2–4 meses |
| **F3 — Switchover** | Playwright e2e completo (93 specs) + `test:browser` + presupuestos de rendimiento contra Go; goldens; saldar TODOS los "diferido a F2/F3" de §9; plan de corte y reversa | ~2–4 semanas |

La puerta D15 (fin de F0) decide con evidencia si F1–F3 proceden; los
estimados asumen el ritmo solo-dev + agentes de esta base de código.

### Comportamientos que la UI observa indirectamente (también "sin excepciones")

- Ejecución durable real (worker): estados de nodos en vivo vía SSE, retries,
  DLQ que aparece en Recovery Center, replay/redrive que revive runs.
- Schedules que disparan runs; triggers entrantes (webhooks firmados) que
  crean runs y aparecen en la UI; buffering durante pausas del circuito.
- El contrato AI-fallback: cada superficie AI degrada a determinista sin
  romper la UI (funciona sin clave de proveedor).
- Presencia de `X-Request-Id`, envelopes de error exactos (la web matchea
  códigos para i18n), cursores intercambiables, semántica de permisos por
  pestaña (`tab-permissions` depende de `auth/context`).

## 11. Inventario: superficie exacta que consume la web (develop @ c1aa11e2)

Extraído del código del web (`api()`/`apiRaw()` + streams). **108 rutas
únicas** (los sufijos `/` indican segmento dinámico `:id`/`:name`), más el
stream SSE. Este inventario es la lista de control de F1/F2; se re-verifica
contra los diffs de develop antes de cada tanda.

```
/ai/explain-run
/ai/explain-workflow
/ai/generate-workflow
/ai/health
/ai/patch-workflow
/ai/review-workflow
/ai/suggest-improvement
/alerts/policies
/alerts/policies/
/alerts/recent
/auth/context
/auth/invitations/accept
/auto-healing/
/auto-healing/pending
/billing/budget
/billing/usage
/causal
/check
/children
/comment
/credentials
/credentials/
/credentials/health
/dlq
/dlq/bulk-replay
/dlq/bulk-resolve
/dlq/cluster-apply
/dlq/cluster-members
/dlq/clusters
/dlq/counts
/dlq/replay
/dlq/resolve
/dlq/validate-fix
/eval/datasets
/experiments
/experiments/
/experiments/run
/handoff
/health
/integrations/external-runtimes
/integrations/external-runtimes/
/integrations/slack/interactions
/integrations/slack/interactions/
/mcp/connections
/mcp/connections/
/members
/members/invite
/members/role
/memory/consent-status
/onboarding
/org/config
/org/roles
/org/roles/
/org/scim/directories/
/org/scim/group-role-mappings/
/organizations
/ping
/plugins/install
/prompts
/recovery/calibration-status
/recovery/campaigns
/recovery/campaigns/
/recovery/campaigns/preview
/recovery/feedback
/recovery/home
/recovery/items/
/recovery/metrics
/recovery/playbooks
/recovery/playbooks/
/recovery/playbooks/match
/resume
/run
/run/cancel
/run/usage
/runs
/runs/redrive
/runs/replay-lab
/runs/replay-lab/fork
/snippets
/snippets/
/solution-packs/incident-triage/inject-failure
/start
/status
/system/queue
/templates
/tools
/upstream/sources
/upstream/sources/
/users/me
/validate
/workflows
/workflows/
/workflows/folders
/workflows/folders/assign
/workflows/folders/delete
/workflows/folders/rename
/workflows/health
/workflows/health/delta
/workflows/import-pack
/workflows/readiness
/workflows/rollback
/workflows/save
/workflows/schedule-preview
/workflows/tags
/workflows/tags/assign
/workflows/tags/delete
/workflows/tags/rename
/workflows/versions
/runs/:id/stream        (SSE vía fetch + ReadableStream)
```

Familias: workflows (18) · recovery (11) · dlq (10) · ai (7) · org (5) ·
runs+run (7) · integrations (4) · members (3) · experiments (3) ·
credentials (3) · alerts (3) · resto (auth, billing, upstream, snippets,
mcp, auto-healing, system, tools, templates, solution-packs, onboarding,
memory, users, prompts, plugins, causal, validate, resume, start, status,
health, ping, check, children, comment, handoff — estos cuatro últimos son
sub-rutas de `recovery/items/:id`).

Notas de precisión para F1/F2 (verificadas en el código web):
- `check` = `GET /check` (health del API en el arranque del web).
- `children`/`comment`/`handoff` cuelgan de `recovery/items/:id/...`.
- `eval/datasets` y `experiments/*` = harness de experimentos.
- `plugins/install` + `solution-packs/*/inject-failure` = demos/packs.
- La web nunca llama triggers de ingest directamente, pero F2 los cubre
  porque sus efectos (runs entrantes) son visibles en la UI.

## 12. Independencia de rutas y de agente (directiva 2026-07-30)

**Nada del piloto depende de rutas de una máquina ni de un agente
concreto.** Garantías verificadas:

- Todo lo necesario vive EN LA RAMA: `go/PLAN.md` (plan vivo),
  `go/JOURNAL.md` (bitácora), `go/AGENTS.md` (onboarding cross-agente — el
  archivo que Codex/Cursor leen nativamente), código, Makefile, compose.
- El Makefile y los scripts usan solo rutas relativas (`cd ..` hacia la raíz
  del repo); el proyecto Compose tiene nombre fijo (`janusly-go-pilot`) y
  puertos fijos (4600/4601/4632) — independientes del directorio.
- **El worktree es una conveniencia, no un requisito.** Modos equivalentes:
  (a) worktree local en cualquier ruta:
  `git worktree add <cualquier-ruta> go-pilot`;
  (b) clon normal + `git checkout go-pilot`;
  (c) workspace cloud de otro agente sobre `origin/go-pilot`.
- Para usar OTRO agente: dale la rama y una sola instrucción — "lee
  `go/AGENTS.md` y sigue el protocolo". El estado de tareas está en el plan
  versionado, no en la memoria de ningún agente.
- La copia del plan en `docs/proposals/` del checkout de Johnny es una
  conveniencia de lectura, NO fuente de verdad; puede desactualizarse sin
  consecuencia.
- Única dependencia externa a la rama: el repositorio mismo (migraciones
  compartidas, contrato OpenAPI, y la rama `develop` como referencia de
  paridad) — que es exactamente lo que cualquier agente ya tiene al clonar.
