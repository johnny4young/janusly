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
| T-003 | Dominio: parsing + validación subconjunto (códigos de issue) | P0 | done |
| T-004 | startRun transaccional + defaults de inputs | P0 | done |
| T-005 | Cola propia: claim loop, worker pool, LISTEN/NOTIFY | P0 | done |
| T-006 | Gramáticas subconjunto: templates + expresiones | P0 | done |
| T-007 | Executors: noop, transform, condition + semántica de aristas | P0 | done |
| T-008 | Modelo de fallo: retry ladder + dead_letters | P0 | done |
| T-009 | wait_until + approval/waiting + POST /resume | P0 | done |
| T-010 | Redrive desde dead_letters | P0 | done |
| T-011 | Executor http + SSRF/DNS pinning | P0 | done |
| T-012 | API /v1 mínima + envelopes + goldens de referencia Node | P0 | done |
| T-013 | Arnés de paridad semántica (lane A, fixtures F01–F10) | P0 | done |
| T-014 | E2E de API Go (lane B) | P0 | done |
| T-015 | Servidor MCP stdio + e2e vía MCP (lane C) | P1 | done |
| T-016 | Rendimiento: k6 + RSS + pprof vs Node | P1 | done |
| T-017 | Journal consolidado + análisis de fricción | P1 | done |
| T-018 | Puerta D15: informe + recomendación | P0 | done |
| T-101 | (stretch) Tick de schedules con líder por advisory lock | P2 | todo → ola 6 T-177 |
| T-102 | (post-piloto) LlmClient Go sobre SDKs oficiales | P2 | done (ola 4: chokepoint anthropic-sdk-go T-099..T-102) |
| T-103 | (post-piloto) pdf.generate: evaluación maroto v2 | P2 | todo → ola 6 T-164 |
| T-104 | (F3) embed.FS con el dist del web | P2 | todo (post-go/no-go — decisión de empaque del cutover) |
| T-200 | (F1) auth/context + sesión + permisos por pestaña | P0 | done (olas 2-3: registry central + /auth/context) |
| T-201 | (F1) catálogos: tools/templates/solution-packs/snippets/prompts | P0 | partial (tools/templates/prompts done olas 3-4; packs+snippets → ola 6 T-180) |
| T-202 | (F1) workflows: CRUD/versions/metadata/tags/folders/health | P0 | partial (CRUD/versions/trash done olas 2-3; tags/folders/health → ola 6 T-181/T-182) |
| T-203 | (F1) runs: list/detail/status/usage + SSE stream | P0 | done (olas 2-3) |
| T-204 | (F1) Recovery Center lecturas: home/metrics/items/dlq/heatmap/calibración | P0 | done (ola 5: T-140..T-148) |
| T-205 | (F1) credentials(+health)/members/roles/org-config/billing/onboarding/audit/system | P0 | partial (members/roles/org-config/audit/system done ola 3; credentials → ola 6 T-159..T-161; onboarding → T-180) |
| T-206 | (F1) hito: la web arranca contra Go y navega sus pestañas de lectura | P0 | done (smokes 5/5, olas 3-5) |
| T-300 | (F2) escrituras DLQ/campañas/playbooks/feedback/auto-healing/alerts | P0 | partial (todo done olas 2-5 salvo auto-healing → ola 6 T-178) |
| T-301 | (F2) AI surfaces completas con contrato AI-fallback | P0 | done (ola 4 completa) |
| T-302 | (F2) triggers/webhooks firmados + scheduler + crons system | P0 | partial (webhooks done ola 3; email/file/mcp → T-168/T-169; scheduler+crons → T-177..T-179) |
| T-303 | (F2) los 26 tipos de nodo + gramáticas completas (paridad total) | P0 | partial (faltan subworkflow/schedule/loop-for_each/triggers → ola 6 T-174..T-177) |
| T-304 | (F2) Secret Store/HMAC/memoria/MCP/SCIM/rate limits/i18n server-events/permisos completos | P0 | partial (HMAC/memoria/MCP/rate/permisos done olas 3-4; Secret Store → T-159/T-160; SCIM → ola 6 T-191..T-194) |
| T-305 | (F2) rollouts canary + import packs + upstream + experiments | P1 | partial (rollouts done ola 5; packs → T-180; upstream → T-171; experiments → ola 6 T-189/T-190) |
| T-400 | (F3) Playwright completo + browser + perf budgets verdes contra Go | P0 | todo (la lane completa excede los 5 smokes; parte vive en ola 6 T-183/T-185) |
| T-401 | (F3) saldo de diferidos §9 + plan de corte y reversa | P0 | todo → ola 6 T-187 |

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
| 2026-07-30 | goldens capturados | 17 goldens del stack Node REAL en `go/conformance/goldens/node/` (API arrancado desde el worktree limpio en el pin — el checkout principal tenía modificaciones de otra sesión; develop había avanzado 2 commits pero el diff sobre apps/api+packages era VACÍO → pin-equivalente). Envelope `{apiVersion:"v1", requestId, data|error}` + header X-Request-Id; error `{code, message, params?}` |
| 2026-07-30 | hallazgo (goldens) | Run desconocido y run cross-org son AMBOS `403 runs_forbidden "Forbidden"` — invisibilidad indistinguible, no 404. Resume conflict = `409 runs_resume_conflict "Node is not waiting"`. `/run` y `/status` proyectan la MISMA data `{run, nodes, events, eventsCursor, eventsHasMore}`. `start` → `{runId}` con 200. Listas (`/v1/runs`, `/v1/dlq`) → data = array pelado |
| 2026-07-30 | decisión | Columnas que el piloto aún no llena (rollout, outcome, trace, recovery overlay del DLQ…) emiten NULL, nunca claves ausentes — el key-set completo del golden se preserva y el web F1 no necesita tolerancia. Save acepta el vocabulario completo de la plataforma (tipo no ejecutable = problema de START, no de save); binario único api+worker por ahora |
| 2026-07-30 | corrección de testing | Los claims son globales por diseño → pools de workers de paquetes de test corriendo en paralelo se completaban nodos ajenos (un stub noop "completó" un http bloqueado). Lane de integración ahora `-p 1`; y CompleteNode/FailNode borran su wakeup consumido en la misma tx (limpieza determinista, no dependiente del sweeper) |
| 2026-07-30 | divergencia anotada | `POST /v1/dlq/redrive` es superficie propia del piloto (Node: `/v1/dlq/replay` exact-identity); códigos `dlq_not_found`/`dlq_replay_conflict`/`runs_input_invalid`/`workflows_validation_failed` no capturados en goldens (el golden de save salió 400 por forma de body — el body es el workflow al TOPE, no `{workflow}`); paginación por cursor en listas y `workflows_save_conflict` de Node verificar en T-013. Goldens de save-éxito y dlq-replay pendientes de recaptura |
| 2026-07-30 | HITO | Paridad semántica F01–F10 EN VERDE A LA PRIMERA: 11 proyecciones (F02 partida a/b) idénticas a los goldens del stack Node real — status final, estado+attempts por nodo, outputs proyectados, conteo de dead letters. `make parity` reproducible; fixtures compartidas en conformance/fixtures.json con pasos declarativos y `{{UPSTREAM}}` por runner |
| 2026-07-30 | divergencia aceptada (única) | F05: el replay de Node RE-ARMA el nodo fresco (attempts vuelve a 1 bajo su maquinaria de recovery claims); el redrive del piloto preserva la evidencia y avanza el contador (2 fallos + éxito redriveado = 3). Tabla `acceptedDivergences` en el runner con el porqué |
| 2026-07-30 | nota | Los goldens de paridad se generaron con el stack Node del worktree (pin) + stub upstream determinista idéntico en ambos runners (ok/fail/flaky+heal); ALLOW_PRIVATE_HTTP_TARGETS=true en ambos lados para F03-F05 (upstream local) |
| 2026-07-30 | e2e binario real | T-014: los dos ciclos del README conducidos por HTTP contra el binario COMPILADO en puertos efímeros — cuña de recuperación (save→start→500→DLQ→heal→redrive→succeeded con downstream completado) y puerta de operador (approval→resume→outputs proyectados leyendo default de input + estado downstream). El teardown verifica el drain limpio en SIGTERM — el contrato de lifecycle probado en cada corrida |
| 2026-07-30 | MCP en proceso | T-015: `cmd/mcp` con el SDK Go oficial (v1.7.0) — 6 tools sobre el engine SIN salto HTTP; fallos esperados como `isError` (postura del mcp-server Node); resultados JSON + structuredContent; el proceso corre el worker pool (los runs progresan sin otro servicio). Org por `JANUSLY_GO_ORG` (análogo dev-auth para stdio). E2E: cliente SDK in-memory ejecuta el ciclo fallo→DLQ→redrive→succeeded + conflicto legible + timeline con node.redriven |
| 2026-07-30 | gotcha (SDK) | `json.RawMessage` en args de tool deriva schema "array de números" (es []byte) — los documentos workflow van como `map[string]any` y se re-serializan; el jsonschema del SDK valida ANTES del handler |
| 2026-07-30 | pendiente manual | Demo con Claude real (registrar cmd/mcp vía claude mcp add y conducir el ciclo) — snippet en go/README.md; anotar en journal al hacerla |
| 2026-07-30 | divergencia de card | T-016 sin k6 (no instalado): generador de carga PROPIO en Go (`cmd/loadgen`) — reproducible en la rama, mismos 3 escenarios, sin dependencia externa; cargas 10/50 VUs × 30s (la card decía hasta 200×2min — escalado a la máquina). Resultados crudos en conformance/perf/results-2026-07-30.json + perfil pprof CPU del diamond |
| 2026-07-30 | números (lo bueno) | Go gana claro en baja contención: start@10VU 187.9 runs/s vs 45.9 (4.1×, p50 34.6ms vs 195.9ms); list@50VU 2800 vs 1085 RPS; diamond@10VU 136.4 vs ~29.5 runs/s. Huella: 21.9 MB idle / 34.3 pico, UN proceso — vs ~101 MB idle api+worker + Redis en Node |
| 2026-07-30 | hallazgo (lo honesto) | Go start@50VU degrada feo con concurrencia 8 (p99 19.9s); subir a 32 arregla la cola (p99 2.3s) pero el throughput no sube y diamond@c32 COLAPSA 8× — sospechoso principal: pool de DB hardcodeado en MaxConns 10 (32 workers + pollers del API compitiendo por 10 conexiones). Follow-up F0.5: pool configurable + pools separados API/workers + retest. Node degrada con gracia a 50VU (modelo async de BullMQ) |
| 2026-07-30 | hallazgo (Node) | 2/445 diamantes de Node NUNCA completaron (join jamás disparó; poll-timeout a 90s) y un intento previo sin límite colgó indefinido — reproducción probable del hazard de ordering del readiness scan ya reportado upstream. Go: 4100/4100 |
| 2026-07-30 | F0 CERRADA | T-000..T-018 done (T-1xx stretch pendientes). Las 4 condiciones de la puerta D15 cumplidas — informe en go/REPORT-D15.md con recomendación: continuar a rewrite por fases, previo F0.5 corto (pool DB configurable+separado, recaptura de 2 goldens, demo MCP manual). La decisión estratégica es de Johnny |
| 2026-07-30 | sync develop | Pin avanzado 0f294ad2 → 7febb99c (merge). Diff digerido: 2 commits de calificación local (tenant-isolation + load-soak: scripts smoke, políticas, specs e2e, docs) + retoque de UserMenu.tsx. CERO impacto en apps/api / packages/engine / packages/shared — goldens y paridad siguen válidos sin recaptura. El smoke de load-soak de Node es referencia útil para el lane de rendimiento del piloto |
| 2026-07-30 | T-019 confirmado | La separación de pools ERA el acantilado: start@50VU 49.3→274.6 runs/s (5.6×) con p99 19.9s→337ms (59×); list 2800→6220 RPS. Config nueva: `JANUSLY_GO_API_POOL_SIZE` (10) + `JANUSLY_GO_WORKER_POOL_SIZE` (0 = concurrencia+2). El primer retest mostró 7628 "errores" que eran artefacto del LOADGEN (Transport default MaxIdleConnsPerHost=2 → agotamiento de puertos efímeros a 500 runs/s; backend limpio 11966/11966) — keep-alive 512 y cero errores |
| 2026-07-30 | hallazgo (T-019) | diamond@10VU con c=32 rinde 90/s vs 136/s con c=8: la contención del advisory lock por run crece con workers sobre POCOS runs concurrentes — la concurrencia debe dimensionarse a runs concurrentes, no solo a nodos. Anotado para la guía de operación (T-060) |
| 2026-07-30 | T-020 reaper | Postura Node portada: fail-into-DLQ, NUNCA re-ejecutar (el side effect pudo cometerse — el operador decide vía redrive); CAS de FailNode garantiza que un nodo que completó entre scan y write jamás se pisa y réplicas concurrentes no doble-cosechan; piso de umbral 15 min en StartReaper (tests ejercitan ReapStalledNodes directo); never-throws (error por nodo → log + siguiente sweep). Identidad del stall en error_json: {name:"StalledNodeError", code:"WORKER_STALLED"} — divergencia menor: Node lleva reason:"worker_stalled" en metadata del evento |
| 2026-07-30 | T-021 cancel | Paridad exacta de persistence.ts:505-524 + runs-routes.ts:869-889: run→cancelled incondicional (el guard terminal es del API), nodos pending/queued/waiting→cancelled con `state_json {cancelled: reason}` + finished_at, `running` EXCLUIDO (termina natural; el guard post-éxito absorbe el downstream — probado), evento `run.cancelled` payload=reason. Guards: 400 runs_run_id_required / 404 runs_run_not_found / 403 runs_forbidden / 409 runs_already_terminal con mensaje literal "Run is already {{status}}; cannot cancel" + params.status. HALLAZGO: cancel SÍ distingue 404 de 403 (las lecturas de run no) — asimetría deliberada de Node fijada con test. Wakeups de nodos cancelados los recoge el sweep (ya no-waiting) |
| 2026-07-30 | T-022 goldens 2ª pasada | 12 goldens nuevos del stack del pin. Confirmado: save success `{workflowId, versionId, version}` incremental (mi Go ya coincidía); `/v1/dlq/replay` éxito = `{ok:true}` y conflicto = mensaje largo "This run can no longer be replayed — it was cancelled or already recovered". HALLAZGO IMPORTANTE: el contrato v1 de cancel difiere de la ruta legacy que porté — Zod valida ANTES: runId faltante → `invalid_input {field:"runId"}` (no runs_run_id_required) y `reason` es STRING opcional (un objeto → 400 field:"reason"). Ruta Go corregida a v1-exacto + alias `/v1/dlq/replay` con la forma de Node (el `/v1/dlq/redrive` propio se mantiene). El golden 409-terminal de cancel no se capturó (el 400 del reason-objeto consumió el intento) — el mensaje del 409 queda de la lectura de fuente |
| 2026-07-30 | T-023 BUG REAL (EPQ) | El flake era un bug de concurrencia genuino: bajo READ COMMITTED, el claim de un solo UPDATE-con-subquery sufre EvalPlanQual — si la fila cambió desde el snapshot del statement, el re-check re-evalúa el `NOT EXISTS` del wakeup CON EL SNAPSHOT VIEJO (pre-insert del wakeup del retry) → un retry diferido de 60s se reclamaba al instante (~1/10). Diagnóstico por instrumentación del test (node=succeeded/2 execs=2) tras descartar procesos huérfanos y drift de reloj del VM (69ms). Fix: claim en DOS statements en una tx — lock SKIP LOCKED de candidatos + UPDATE con TODOS los guards re-checkeados en snapshot FRESCO sobre filas ya bloqueadas (sin EPQ posible). 30/30 verde post-fix |
| 2026-07-30 | T-024 métricas | Serie propia `janusly_go_*` (nunca impostora de los exporters de Node): claims, completions{outcome}, retries, runs_terminal{status}, reaped, redrives, histograma de ejecución (buckets exponenciales 1ms..~10min), y `queue_depth{state}` vía collector custom con caché de 5s (un GROUP BY acotado; scrapes concurrentes coalescen — la postura del /health de Node). Incrementos junto al commit de cada transición; e2e verifica las 5 series contra el binario real por el puerto interno |
| 2026-07-30 | T-025 make ci | Lane de verdad en una orden: generate + guard de drift de sqlc (`git diff --quiet -- internal/store` — código generado descuadrado = fallo, no sorpresa en review) + build + lint + test (-race -p 1) + parity F01-F10. Exit honesto. Deliberadamente local (no workflow de GitHub: los push del repo privado cuestan; misma filosofía del eval-gate de Node fuera de CI) |
| 2026-07-30 | T-026 keyset /v1/runs | Cursor `before=<iso>\|<id>` del contrato (opaco; el CLIENTE deriva el siguiente de la última fila — la respuesta sigue siendo array pelado, como Node) + filtros workflowId/status. HALLAZGO: el filtro workflowId de Node lleva un fallback para runs ad-hoc — `wv.workflow_id = $f OR (wv.id IS NULL AND r.workflow_version_id = $f)` (runs-routes.ts:471-475): los starts inline sin fila de versión filtran por el version-id del run. Portado exacto. Cursor inválido → 400 invalid_input field "before". runKind=validation queda para cuando existan validation runs |
| 2026-07-30 | T-027 workflows read | Tres rutas del inventario web: GET /v1/workflows (key set completo de WorkflowListRowSchema — runCount + lastRunStatus con el mismo match ad-hoc-aware del filtro de runs; tags []/folder null/bufferedTriggerCount 0 hasta que exista metadata/buffering), /latest (contrato NULLABLE: workflow activo sin versiones = data null, no error; dagJson round-tripea el documento guardado), /versions (newest first). Gate compartido requireActiveWorkflow: param faltante → invalid_input field workflowId; desconocido/tombstone/cross-org → el mismo workflow_not_found (invisibilidad) |
| 2026-07-30 | T-028 CORS/browser | Middleware WithBrowserHeaders portando http.ts/server.ts: `API_ALLOWED_ORIGINS` (mismo env, mismos defaults Vite :5173/:5174), echo del Origin SOLO si está en la allowlist + Allow-Credentials, listas de Methods/Headers/Expose VERBATIM (incluye x-janusly-csrf y Last-Event-ID para el SSE de T-031), Vary: Origin siempre, OPTIONS→204, y `x-request-id` entrante honrado si pasa el patrón `[A-Za-z0-9._-]{1,128}` (un id hostil con CRLF se reemplaza por uuid — test lo fija). El requestId del envelope ahora es el del middleware — trazas cosidas cliente↔servidor |
| 2026-07-30 | T-029 inventario F1 | go/F1-GAPS.md. HALLAZGO ESTRUCTURAL (api.ts:292-305): el web prefija /v1 SOLO en GETs del set V1_READ_PATHS (y des-envuelve él mismo); las MUTACIONES van SIEMPRE a rutas legacy crudas — /start, /resume, /run/cancel, /workflows/save, /dlq/replay deben existir como alias legacy sin envelope (un handler, dos encoders — como Node). Excepción documentada: /dlq?id= va legacy aunque /dlq esté en v1. Dev-headers del web (x-org-id default / x-user-id dev-user) compatibles tal cual. Lecturas ya alineadas: workflows/latest/versions/runs/run/status/dlq ✓. Fuera de alcance degrada offline-limpio (verificar en T-035) |
| 2026-07-30 | T-030 lecturas soporte | `GET /health` legacy ABIERTO (sin auth, como Node) con la forma pública-segura del golden: rateLimiter healthy (no hay limiter aún) + queue.degraded respaldado por un ping REAL acotado a la DB (2s); `GET /org/config` → `{config:[]}` — la lista vacía es la respuesta honesta de una org fresca (misma que Node sin filas). Alcance depurado contra fuente: /ping NO es ruta del servidor Node (falso positivo del inventario), /users/me solo existe como POST de perfil, /onboarding degrada amigable → reclasificados en F1-GAPS |
| 2026-07-30 | T-031 SSE | Protocolo de referencia completo: `retry: 3000` + `: connected`, catch-up desde `Last-Event-ID` compuesto (sin header = desde el inicio — el overlap deliberado que el web dedupe por id), frames `id: <iso>\|<eventId>` / `event: run-event` / data `{kind:"event",...}`, cap 500 + `catchup-truncated` que CIERRA (el browser reconecta), `run-status` en cada cambio, heartbeat 25s comment. El tail vivo: LISTEN `janusly_go_run_events` (NOTIFY dentro de CADA tx que escribe eventos — completion-family, start, cancel, redrive) en vez del hub Redis de Node + fallback poll 1s (una notificación perdida solo retrasa). Guard idéntico a lecturas: 403 indistinguible. Divergencia menor: sin cap de suscripciones por org (streamMaxSubscriptions) aún |
| 2026-07-30 | T-032 wire dual | La arquitectura de alias de Node replicada: UN core por mutación (`startCore`/`resumeCore`/`cancelCore`/`saveCore`/`replayCore` → `opResult` wire-agnóstico) + dos encoders — legacy crudo (`{...}` / `{error: message, code, params?}`) y envelope v1. Drift entre wires estructuralmente imposible. Aliases legacy montados (los que el web POSTea): /start `{runId}`, /resume, /run/cancel `{runId,status}`, /workflows/save, /dlq/replay `{ok:true}`. Lecturas legacy DLQ: /dlq/counts REAL `{total,open,replayed,resolved}` (GROUP BY) y /dlq?id= detalle con snapshot exacto de replay + overlays (suspectVersion/drill/drillOutcome) como null honesto. /dlq/queue diferido a T-044 (atado a la maquinaria de recovery-overlay; panel experto degrada) |
| 2026-07-30 | T-033 soft-delete | Postura de cascada de Node completa: DELETE tombstone (`{workflowId, ok}`), exclusión en TODAS las lecturas activas, `GET /workflows/trash` (misma fila de lista con deletedAt, orden (deleted_at,id) DESC, keyset propio `before=<deletedAtIso>\|<id>`), restore que revierte, y la regla de la casa "un save JAMÁS resucita un tombstone" (PK-conflict → distinguir tombstone-mismo-org 404 vs cross-org 409 vía GetWorkflowOwnerState). BUG LATENTE cazado: `last_run_status` de las listas explotaba con NULL para workflows sin runs (sqlc infiere subqueries escalares/LATERAL como non-null — limitación conocida); fix COALESCE('') + restauración del null en el wire |
| 2026-07-30 | lección operativa | `kill %1` en shell no-interactivo NO mata jobs — un binario de probe huérfano quedó reclamando nodos con executors REALES y causó 2 fallos fantasma (métricas + flaky-node "succeeded/1"). Higiene nueva: pkill por ruta tras cada probe manual |
| 2026-07-30 | T-034 rollback | Pre-checks de workflows-rollback.ts portados: padre activo (tombstone = not-found para escrituras — el mismo comentario de la fuente), versión fuente org+workflow-scoped (source de otro workflow/org = `workflows_source_version_not_found` 404), DAG fuente bien formado (`workflows_version_malformed` 422), conflicto de incremento → 409 `workflows_rollback_conflict` con params.attempts. Éxito `{workflowId, versionId, version, sourceVersion}` — el rollback APPENDEA (v3 = snapshot de v1), nunca borra historia. Ambos wires vía rollbackCore. `rollout_active` fuera de alcance (sin rollouts en pilot); sin retry bounded de unique-violation (single-attempt → conflicto directo, anotado) |
| 2026-07-30 | T-035 HITO F1 | EL WEB REAL CORRE CONTRA GO: smoke Playwright verde — la app monta, el feed de Activity renderiza runs sembrados leyendo /v1/runs de Go, el approval en espera cuenta en needs-action (proyección de nodos), y CERO page errors (paneles fuera de alcance degradan como prometía el wrapper). Reproducible: `node go/conformance/run-web-smoke.mjs` (bootea binario Go + vite vía webServer de Playwright con VITE_API_URL) |
| 2026-07-30 | hallazgo (T-035) | El gap invisible del inventario: `GET /auth/context` — el bootstrap de identidad que el web hace ANTES de todo. Sin él, `permissionsRef` queda vacío y CADA lectura cae a su fallback (síntoma engañoso: app montada, feed vacío, cero errores). Servida la rama dev-headers de Node: org sintética admin developmentFallback con las 41 claves del catálogo (extraídas de permission-catalog.ts en el pin) |
| 2026-07-30 | T-036 tool registry | `internal/tools` con la familia json (parse/pick/set/merge) portada incluidos sus guards de prototype-pollution (`__proto__`/`prototype`/`constructor` rechazados en paths de set y saltados en merge — en Go no hay prototipo que envenenar, pero un payload del pilot puede volver al backend Node: se refutan igual). Nodo `tool` con el envelope de referencia `{tool, result}` + `resultPolicy` ("envelope" default fluye el fallo; "require_ok" falla el nodo). Catálogo `listTools()` (name/description/required/optional/inputExample/inputFields/writeSide) servido en /v1/tools y /tools. `tool` entra en PilotNodeTypes (el test de tipo-no-ejecutable migró a `ai`) |
| 2026-07-30 | T-037 fork/join | Los shells declarativos portados de parallel-fork.ts: fork = passthrough que valida 2..10 branches únicas (≤64 chars, desc ≤280) y devuelve `{branches}` como eco; join = ensambla `output.branches` por ETIQUETA leyendo `context[predId].output` (dup de predecessor rechazado — el copy-paste surfaceado fuerte). El fan-out/fan-in real ya lo daba el engine (ALL-AND + claim atómico) — cero primitivas nuevas de runtime, como manda la regla de la casa. Las 3 reglas del gate en domain.CheckForkJoinReadiness con severidades (warn/fail); enforcement al gate production-mode cuando exista (T-042). Un branch fallando → join jamás encola (queda pending), run failed — probado |
| 2026-07-30 | divergencia menor | Los mensajes de fork_join_missing_branch_sources/readiness son resumidos (Node compone closest-join + labels faltantes en el mensaje); los códigos y severidades son exactos — el web matchea por código |
| 2026-07-30 | T-038 loop map | El contrato legacy puro portado: items via mapInput + normalizeItems (array tal cual; string split-por-comas trim+drop-vacíos; otro → []), cap 1.000 con LoopItemLimitError exacto, mapping default `{item:"{{item}}", index:"{{index}}"}`, render por ítem con `item`/`index` ligados por iteración (diferidos en el render de config del dispatcher — el diseño deferredRoots de T-006 pagando), evento `loop.completed {count, items}` y output idéntico. Ejecutors ganan los seams Emit (appendEvent) + ReportUnresolved (política late-bound del dispatcher). `for_each` falla honesto ("not executable by this backend yet") — su maquinaria (tool por ítem, presupuestos de fallo, write-side) es ticket propio futuro |
| 2026-07-30 | T-039 verificación | La estructura YA existía (seam de T-003 + gramática de T-006 + saveCore) — el ticket se convirtió honesto en verificación end-to-end: `edge_invalid_condition` con mensaje verbatim + edge_0 sintético, operadores de palabra legales en aristas, violaciones de contrato de operadores (in sobre no-array) rechazadas ESTÁTICAMENTE en save (la pasada empty-scope), y el API surfaceando el issue en params.issues del 400. Ticket de una hora que confirmó cero deuda oculta |
| 2026-07-30 | T-040 selector | Ruta pilot-propia `POST /v1/webhooks/{workflowId}` (envelope v1): el selector se acota al workflow de la URL en vez del resolver org-wide por endpointKey de Node (`/triggers/webhook/ingest`). Workflow desconocido, cross-org y tombstoned son indistinguibles del 404 `trigger_no_matching_node` — un caller webhook no aprende qué existe fuera de su alcance. Dos nodos con la misma clave dentro del workflow → 409 `trigger_selector_ambiguous` |
| 2026-07-30 | T-040 claim CAS | Paridad real en la frontera durable: `StartInput.TriggerEventID` reclama la fila `trigger_events` DENTRO de la transacción de start (mismo posicionamiento que el `triggerEventStart` de Node) — "evento reclamado" y "run existe" comprometen o revierten juntos; el perdedor recibe `TriggerEventStartConflictError` → 200 duplicate. Convergencia de crash-window: fila `received` huérfana adoptada por el siguiente delivery con el payload PERSISTIDO |
| 2026-07-30 | T-040 pausa | Portada la fila `trigger` de la tabla de decisión de pausa (`workflowPausePolicy.ts`): workflow no-activo → evento aparcado como `buffered` + 202 con `reason`=status (aceptado, run diferido; fail-open en status vacío). El backfill-on-resume NO existe en el pilot — las filas buffered quedan drenables por el backend Node (misma tabla compartida). Sin rate-limit por trigger, sin rollouts, sin audit rows (divergencias conocidas del pilot); mensajes de validación de payload nombran el campo (Node relaya el primer issue de Zod) |
| 2026-07-30 | T-040 encoder | `writeVersioned` ignoraba `status` en éxitos (200 fijo) — el 202 buffered lo expuso; ahora los éxitos no-200 conservan su status en el envelope v1 |
| 2026-07-30 | T-041 F11 e2e | Fixture F11 (save → ingest → waitTerminal) prueba la cadena trigger completa contra AMBOS backends: driver Node ingesta por `POST /triggers/webhook/ingest` (selector org-wide por clave), driver Go por `POST /v1/webhooks/{workflowId}` — mismo contrato, misma proyección. Golden capturado del stack Node real: outputs preservan el TIPO del evento (`total: 99.5` numérico) a través de template → outputs de workflow; paridad Go byte-igual |
| 2026-07-30 | T-041 stack aislado | La captura de goldens ya no depende del `pnpm dev` compartido: `conformance/run-reference-stack.mjs` + `reference-stack.compose.yml` bootean el backend Node del pin en proyecto Compose propio (`janusly-goldens`) y puertos propios (PG 4732 / Redis 4733 / API 3101 / métricas 9564-5), sin el lock de ciclo de vida y sin tocar DBs vivas; `down -v` no deja nada. Motivado por un incidente real: un `pnpm dev` lanzado desde el worktree colisionó por nombre de proyecto Compose derivado del directorio y tumbó el Postgres del pilot (volumen sobrevivió; DB restaurada con `make db-up` + verificación) mientras un `run-e2e` de otra sesión poseía legítimamente el lock y :3001. Regla nueva: NUNCA `pnpm dev`/`run-e2e` desde el worktree del pilot — capturas solo vía el stack aislado |
| 2026-07-30 | T-041 residuo | Los fixtures con estado ALMACENADO (save+ingest) no pueden usar id de workflow estático: `workflows.id` es PK global en el esquema compartido y el residuo de una ejecución anterior (otro org) hace 404 el ingest del org fresco. Sustitución `{{RUN}}` (sufijo único por ejecución) en ambos drivers; los fixtures solo-`/start` no la necesitan (documento inline) |
| 2026-07-30 | T-003/T-004 cierre | Ambos `partial` eran contabilidad obsoleta de la ola 1: el trabajo estaba completo y verificado. T-003: 15 casos table-driven con citas a la fuente (wv/iv), ciclo, códigos idénticos, fixtures de docs. T-004: `TestStartRunLeavesNothingOnInjectedFailure` (inyección en el tercer insert), payload trigger satisfecho por defaults, null/false explícitos ganan, NOTIFY dentro de la tx. Además T-039 re-probó el seam de T-003 y F08/F11 ejercitan T-004 en paridad real. Estados corregidos a `done` sin código nuevo |
| 2026-07-30 | T-042 gate | `CheckWorkflowReadiness` portado completo (8 reglas por nodo + outputs + evals opt-in, mensajes/sugerencias verbatim, mismo orden), con dos seams: `IsWriteSideTool` (registry de tools; el refinamiento input-sensible de `http.request` de Node no aplica — el registry del pilot no tiene tools write-side aún) y `RequireEvalCoverage` (misma env `JANUSLY_REQUIRE_EVAL_COVERAGE`). Regex sensible REUTILIZADO de `grammar.IsSensitiveKey` (regla: no bifurcar). Gate en `/start` con la misma env `JANUSLY_PRODUCTION_MODE` → 422 `runs_not_production_ready` SIN params (Node tampoco expone issues en el rechazo del start; el badge sí). `workflow_missing_rollback_version` (warn, DB-layered) portado; `credential_missing` NO (el pilot no tiene Secret Store) |
| 2026-07-30 | T-042 badge | `POST /workflows/readiness` en ambos wires (raw + envelope v1), cuerpo plano o `{workflow}` como Node; inválido estructural → 200 `{status:"fail"}` con códigos `invalid_workflow_<code>` envueltos, igual que la referencia |
| 2026-07-30 | T-043 org config | Subconjunto http del catálogo (`http.timeoutMs`/`maxResponseBytes`/`maxRedirects`) con el contrato exacto del catálogo Node: precedencia config-de-nodo → fila tenant → env (`JANUSLY_HTTP_*`, mismos nombres) → default (30000/1MB/5), mínimos 1/1/0, valores inválidos caen a la siguiente capa sin aplicarse a medias, lectura fallida degrada a env/defaults (nunca falla un nodo por config ilegible). `ClaimedNode` gana `OrgID` (poblado del run row en executeClaim — cero reads extra); el dispatcher resuelve bounds SOLO para nodos http (una query indexada por ejecución, sin caché — divergencia consciente vs el hot-path de Node, revisar si el bench lo señala). `maxRedirects: 0` de tenant es válido y se honra (min 0) |
| 2026-07-30 | T-044 firma | `normalizeErrorSignature` portado completo a `internal/signature` (7 reglas en orden, scrub de formas de token, sanitización de identificadores, truncado a 80). Conversión JS→RE2 razonada: los lookaheads de frontera `(?=$|[^A-Za-z0-9])` son REDUNDANTES en cuerpos abiertos (`{20,}` greedy consume todo) y solo AKIA/AIza (longitud fija) necesitan emulación real (grupo de cola restaurado en el replacement) — un test fija el caso "17 chars tras AKIA no es key". `recurredAfterRecovery` siempre false (sin substrato de impacto en el pilot) |
| 2026-07-30 | T-044 quirk Node | Hallazgo de la referencia reproducido fielmente + chip upstream: `PARSE_ERROR_PATTERN` (regla 5) matchea el NOMBRE del tool `json.parse` case-insensitive dentro de "Invalid tool input for json.parse: …", así que esos errores clusterizan como `parse_error` genérico y nunca llegan a la regla `tool_input` (regla 6). El pilot reproduce el mismo resultado (paridad > corrección local); el fix va al backend Node |
| 2026-07-30 | T-044 clusters | `GET /dlq/clusters` en ambos wires: muestras de dead_letters + run_nodes fallidos en la ventana (1..90 días, default 30, LIMIT 2000 por superficie — cap propio del pilot), dedupe `(runId,nodeId)` prefiriendo DLQ, workflows afectados ordenados por count, 5 sample refs, orden frecuencia desc + firma asc, `totalSamples` cuenta muestras CRUDAS pre-dedupe como Node. Identidad workflow/nodeType/toolName enriquecida del snapshot `input_json.workflow` del run |
| 2026-07-30 | T-045 pump | Campañas de replay sobre el MISMO esquema compartido (`replay_campaigns` + `replay_campaign_items`), pero sin espejo BullMQ: el due-clock de Postgres (que Node declara autoritativo) se bombea directo — `ClaimDueReplayCampaign` avanza `next_dispatch_at` por su propio pacing EN el mismo statement (FOR UPDATE SKIP LOCKED), así que pumps concurrentes no pueden doble-despachar y no existe publicación que reconciliar. Un paso = a lo sumo un replay (pacing nunca es sleep de loop); items con lease por claim-token; cancelación corta claims nuevos y reporta contadores veraces (el item en vuelo termina). Reutiliza `RedriveDeadLetter` por item (misma tx de revival). Rutas legacy `/recovery/campaigns[/preview|/{id}|/{id}/cancel]` con códigos/bounds verbatim (100 items, nombre 120, pacing 1000..60000, cohorte ≥2 misma-firma resuelta server-side); sin guardMcpWrite ni audits (pendientes del pilot) |
| 2026-07-30 | T-045 lifecycle DLQ | Gap real destapado por el test de re-elegibilidad: el redrive del pilot reclamaba `replay_claimed_at` sin voltear `status` — un dead letter reproducido quedaba `open` para siempre y el preview lo creía elegible para una segunda cohorte. Ahora el claim ES el flip de ciclo de vida (open → replayed + `replayed_at`) en un solo statement, igual que la semántica de Node |
| 2026-07-30 | T-046 F12-F17 | Lane de paridad ampliado a 18 fixtures con 6 nuevos capturados del stack aislado: F12 cancel sobre timer en waiting (run cancelled + nodos pending cancelados igual que Node), F13 fork/join merge etiquetado leído desde outputs, F14 loop map sobre items declarados del input, F15 normalización de string con comas (trim + drop vacíos), F16 condiciones de arista con operadores de palabra (`contains`/`in`) ruteando, F17 templatePolicy strict → nodo failed + 1 DLQ. Paridad byte-igual AL PRIMER INTENTO en los 6 — cero divergencias nuevas. El área "keyset" del ticket se mueve a T-058 (donde vive el round-trip de cursores); verbo `cancel` añadido a ambos drivers; `GOLDENS_ONLY` acepta lista separada por comas |
| 2026-07-31 | T-047 pg15 | Lane `make test-pg15`: Postgres 15 efímero (proyecto/puerto/volumen propios — el volumen dev es initdb de PG18 y no puede correr bajo 15), suite completa `-race -tags integration -p 1` verde en 13 paquetes. Todo el SQL del pilot (LATERAL, make_interval con args nombrados, SKIP LOCKED, advisory locks, NOTIFY en tx) es compatible con el floor sin cambios |
| 2026-07-31 | T-047 migrate gap | El lane destapó un gap real de setup: `make migrate` solo aplicaba las migraciones drizzle compartidas y NUNCA `migrations/0001_go_pilot.sql` (la DB dev la recibió a mano) — sin `go_pilot_wakeups` los retries/timers no agendan y F17 colgó 30s hasta timeout con la paridad tardando 541s. Ambos targets aplican ahora la migración del pilot (idempotente) tras drizzle; con el fix la paridad pg15 corre en 3.8s |
| 2026-07-31 | T-047 race test | Segundo hallazgo del lane: el test de cancelación de campañas leía los contadores EN la respuesta del cancel, pero un item reclamado antes del cancel legítimamente termina DESPUÉS (comportamiento documentado) — en pg15 el timing lo destapó. El test ahora espera el asentamiento de todos los items y luego exige contadores veraces |
| 2026-07-31 | T-049 strip | Strip de credenciales en redirects por ORIGEN (scheme+host+puerto efectivo, spec fetch) dentro del CheckRedirect ya existente: la lógica propia de Go compara DOMINIOS (mismo host o subdominio conserva Authorization/Cookie en cualquier puerto y nunca toca Proxy-Authorization) — un redirect al mismo host en otro puerto, un downgrade de scheme o un salto de subdominio habría reenviado la credencial. Same-origin conserva. Divergencia documentada: la semántica de método en redirects sigue siendo la de Go (301/302 reescriben todo no-GET/HEAD a GET; fetch solo POST) — reimplementar el loop manual no se justifica para el pilot |
| 2026-07-31 | T-048 k6 | `make bench` = k6 (tres escenarios SECUENCIALES de 20s: start→terminal, list caliente, diamond F09) + serie temporal `series.jsonl` + `BENCH.md` regenerado con columna de DIRECCIÓN (↑ mejor / ↓ mejor) y veredicto que ya aplica la dirección (✅ mejora / ⚠️ regresión / ≈ igual, umbral 5%, nota de ruido ±20% por crecimiento de la base). `cmd/loadgen` se queda como herramienta de comparación CROSS-backend; k6 es la regresión mono-backend en el tiempo |
| 2026-07-31 | T-048 lista inflada | El k6 destapó que los números de `list` del loadgen eran contra un org VACÍO (cada invocación estrenaba org): 17k req/s con 0 filas. Con org poblado (~10k runs) la lista real daba 338 req/s @ p50 150ms |
| 2026-07-31 | T-048 índice keyset | Causa raíz COMPARTIDA con Node (chip upstream creado): el keyset ordena por `(created_at DESC, id DESC)` pero `runs_org_created_idx` no incluye el tiebreaker `id` → bitmap + top-N sort sobre TODO el org por página (4.5ms @ 10k filas, O(runs-del-org)). Con `go_pilot_runs_org_created_id_idx` alineado: 0.27ms (17×) y la lista poblada pasa a 8.2k req/s @ p95 8ms (24×). El índice vive en la migración del pilot con prefijo `go_pilot_`; el fix Node va por el patrón two-file de índices hot-path |
| 2026-07-31 | T-050 corte | Revisión de mitad de ola en JOURNAL: divergencias VIVAS curadas por área (ingest, runtime, plataforma) separadas de hallazgos puntuales ya resueltos; 4 chips upstream abiertos; deuda de proceso saldada listada. El §9 sigue siendo el registro crudo por ticket; el corte es el índice curado |
| 2026-07-31 | T-051 streaming | `bodyMode:"stream"` opt-in en el nodo http: preview acotado (`streamPreviewBytes` clamp 1024..1048576, default del catálogo vía bounds del tenant + env `JANUSLY_HTTP_STREAM_PREVIEW_BYTES`), salida JSON-safe `{body, streamed, streamedBytes, streamTruncated}` con contabilidad de TODOS los bytes, cap `maxResponseBytes` abortando a MITAD del stream con el mensaje wire exacto, y previews jamás JSON-proyectados. En Go la mecánica es un solo camino de lectura (el body ya es stream) — la diferencia semántica es qué se bufferiza y qué se proyecta |
| 2026-07-31 | T-052 csv | Familia CSV completa: parser RFC 4180 streaming portado del estado compartido de Node (pendingQuote/pendingCr cruzando fronteras de chunk — test barre TODOS los cortes posibles de un doc con escapes y CRLF), `csv.parse`/`csv.stringify` (con las dos refinaciones header↔object-rows verbatim)/`csv.filter` en tools, y `csv.fetch` streaming registrado DESDE executors (el SSRF/pinning vive ahí; tools no puede importar executors) vía `Registry.Register` + constructor compartido `executors.NewToolRegistry()` que dispatcher y catálogo del API usan por igual. Un solo shape de summary en todo camino: pre-stream `{ok:false,statusCode:0}`, aborto mid-stream `{ok:false,streamTruncated:true}` con conteos parciales, non-2xx streameando el body (un error puede ser CSV). Decodificación por chunks byte-a-byte segura (delimitadores ASCII; continuaciones UTF-8 ≥0x80) — sin TextDecoder incremental |
| 2026-07-31 | T-053 retention | Sweep de retención mínimo: cascada dura diferida para workflows tombstone con la MISMA CTE atómica de Node (versions + metadata + workflows juntos o nada), ventana default 30d (`JANUSLY_GO_RETENTION_DELETED_WORKFLOWS_DAYS`), corrida horaria en el binario. Divergencia: barrido GLOBAL con una sola ventana (Node barre por org con `retention.deletedWorkflowsDays` del catálogo por tenant); runs/audit huérfanos se toleran igual que Node |
| 2026-07-31 | T-054 timers masivos | Backlog masivo de timers (ventana de downtime): el sweep drena por LOTES hasta vaciar o gastar el presupuesto por tick (50×40=2000), con FAIRNESS round-robin por run en SQL (`ROW_NUMBER() OVER (PARTITION BY run_id ORDER BY wake_at)` — el primer timer de cada run ordena antes que el segundo de cualquiera) para que un run acaparador no expulse al resto del lote. Conflictos de resume cuentan como progreso (el backlog encogió); cero progreso corta el tick en vez de girar sobre el mismo head-of-line. Probado: 120+3 timers vencidos en dos runs — el primer lote de 50 contiene AMBOS runs y un solo sweep drena los 123 |
| 2026-07-31 | T-055 north star | `GET /recovery/metrics` (ambos wires): `verifiedRecovery` p50/p90 en ms sobre redrives REALES — dead letter con replay reclamado cuyo run llegó a `succeeded`; duración = fila DLQ (detección) → evento `run.succeeded` (verificación), `percentile_cont` en SQL (misma semántica de percentil que la referencia) + `mttrMs` promedio legacy de compatibilidad. Sin muestra → nulls, nunca ceros fingidos. Probado con el ciclo completo real: fallo → DLQ → upstream sana → redrive → éxito verificado; con muestra 1, p50 == p90 == mttr |
| 2026-07-31 | T-056 MCP listas | `runs.list` (filtros workflowId/status) + `workflows.list` en el servidor MCP, reutilizando las MISMAS queries keyset del API (`ListRunSummaries`/`ListWorkflowRows` — mismos aggregates: runCount, lastRunStatus, workflowName) con el contrato de página compartido: default 20/max 100, cursor `<iso>|<id>`, cursor malformado = página uno (nunca error), `hasMore` por sobre-lectura de límite+1. Ocho tools totales |
| 2026-07-31 | T-057 consent MCP | Consent de dos flags portado de `guardMcpWrite`: `JANUSLY_MCP_WRITES_ENABLED=true` (proceso) Y `org_configs mcp.writeConsent=true` (tenant), ambos requeridos antes de que cualquier write-tool MCP actúe (save/start/redrive); mensajes de negación VERBATIM. Divergencias: el MCP del pilot es in-process, así que el 403 HTTP de Node se materializa como isError de tool con el mismo mensaje; sin rate-limit por acción (sin sustrato de limiter). Los reads jamás se gatean — probado en el mismo test del escalón |
| 2026-07-31 | T-058 precisión | Los cursores JS viven en MILISEGUNDOS (Date) pero Go escribía timestamps con µs — un cursor ms sobre filas µs puede SALTAR eventos en la frontera de página (el tuple `(created_at,id) < (cursor)` excluye filas del mismo ms con µs mayores). Fix estructural: TODOS los run_events se estampan truncados a ms (`eventNow()`, incluido run.started que usaba `now()` de la DB) y el cursor de `/run` se acuña en ISO-ms exacto (el shape de `toISOString`) — comparaciones exactas en ambas direcciones Node↔Go |
| 2026-07-31 | T-058 orden ASC | Segunda captura: Go servía la página de eventos en DESC crudo; `paginateRunEvents` de Node la INVIERTE a ascendente dentro de la página con el cursor apuntando al más viejo. Divergencia de wire viva desde F0 (la proyección de paridad no compara eventos) — corregida; round-trip completo probado: páginas de 2 reensamblan la línea de tiempo exacta sin saltos ni repes, colisión mismo-ms desempatada por id, shape del cursor ISO-ms verificado |
| 2026-07-31 | T-063 filtros DLQ | Filtros server-side en `/v1/dlq` + `/dlq`: `status` validado contra el enum cerrado (fuera → 400 `dlq_invalid_status` "Invalid DLQ status" verbatim, nunca página vacía), `nodeId` exacto, `workflowId` vía el join de versiones CON el fallback ad-hoc (mismo patrón que el filtro de runs — cubre workflows no guardados cuyo version-id ES el workflow-id). Los filtros de Node que el pilot no porta (severity/sort/owner/search — necesitan el read-model de recovery queue) quedan anotados |
| 2026-07-31 | T-059 idempotencia | Mejora pilot-propia (Node no la tiene): header opcional `Idempotency-Key` (≤256) en `/start` — la clave `(org, key)` se reclama DENTRO de la tx de start (mismo posicionamiento que el trigger-claim: clave y run comprometen juntos); duplicado → 200 con el runId ORIGINAL, cuerpo indistinguible de la primera llamada. Claves scoped por org; sin header, cada llamada es un run fresco. Tabla pilot-owned `go_pilot_start_idempotency` (sin TTL — candidata al sweep de retención si crece) |
| 2026-07-31 | T-061 fuzzing | Fuzzers nativos de Go sobre las dos gramáticas con propiedades de robustez (no oráculos de corrección): (1) jamás panic/colgarse, (2) acuerdo validar↔evaluar — lo que valida limpio no puede fallar el parse al evaluar, (3) rendering total bajo política lenient (paths sin resolver degradan, no error; secretos faltantes excluidos — su fallo duro es contrato documentado). 4.9M ejecuciones de expresiones + 6.3M de templates, 45s cada uno, cero hallazgos — 534 entradas "interesantes" de cobertura acumuladas. `make fuzz` (FUZZTIME configurable) para corridas más largas |
| 2026-07-31 | T-062 propiedades | 25 DAGs aleatorios forward-only (acíclicos por construcción, 3..12 nodos, 1-2 predecesores por nodo — fan-in natural) bajo pool real de 6 workers, invariantes verificados desde la BASE, no la proyección: exactly-once (succeeded + attempts==1 + un solo evento node.succeeded), ordering (sucesor jamás estampado antes que un predecesor), no-orphan (cero filas no-terminales tras el terminal), terminal (exactamente un run.started + un run.succeeded). Seeds fijos reproducibles; el fallo nombra su seed. Hallazgo menor: `domain.Workflow` construido a mano requiere `DSLVersion` explícito (el path del API lo asume vía Parse) |
| 2026-07-31 | T-060 runbook | `go/RUNBOOK.md`: tabla completa de env vars, systemd/launchd, migraciones (las DOS capas — drizzle + pilot — con el camino sin repo Node), backup = pg_dump (todo el estado vive en Postgres; post-restore los timers los drena el sweep justo y los claims muertos el reaper), upgrade con drenaje SIGTERM y verificación, y tabla de diagnóstico rápido con los síntomas reales de la ola (wakeups ausentes, consent MCP, índice keyset) |
| 2026-07-31 | T-064 redrive UI | El web postea `POST /runs/redrive {runId, nodeId}` — nuevo adapter del pilot sobre su máquina de redrive: resuelve el dead letter abierto del nodo y lo reclama; devuelve el MISMO runId (revive-in-place; la referencia crea un run de continuación de replay — el web reabre lo que llegue). Smoke Playwright del loop real: fila `activity-row-run:<id>` → panel del run → `failed-node-call` visible → sanar upstream → click `redrive-node-call` → run succeeded y el nodo fallido desaparece de la UI. Hallazgos de superficie: un run fallido emite DOS filas en el feed (run + recovery; la recovery abre el drawer, no el panel) y los ad-hoc salen como "Unnamed workflow" (el nombre no viaja al summary). `/dlq/queue` (read-model experto con severity/sort/owner) queda como gap documentado |
| 2026-07-31 | T-065 approve UI | Mismo smoke: fila del run en waiting → `waiting-step-gate` → botón "Approve and resume" (i18n en) → `/resume` → run succeeded y `waiting-steps` desaparece. Cero pageerrors en todo el loop. El runner exporta `ALLOW_PRIVATE_HTTP_TARGETS=true` (el spec hospeda su upstream sanable en loopback) |
| 2026-07-31 | T-066 consolidación | Recaptura COMPLETA de los 18 goldens de paridad desde el stack aislado en una sola corrida: byte-idénticos a los committeados (git diff vacío — la captura es reproducible y el pin no ha derivado) y la paridad Go verde ×3 contra ellos. Hallazgo del booter: el stack aislado no exportaba `ALLOW_PRIVATE_HTTP_TARGETS=true` y el guard SSRF de Node bloqueaba el stub loopback (F03/F04/F05 capturaban un fallo DISTINTO al original) — las capturas parciales previas (F11-F17, sin fixtures http) nunca lo pisaron. Corregido en el booter |
| 2026-07-31 | T-067 números | `conformance/perf/EVOLUTION.md`: tres momentos (Node loadgen / Go F0 loadgen / Go ola-2 k6) con columna de dirección por métrica y notas de honestidad metodológica (herramienta distinta, org poblado vs vacío, la comparación diamond conservadora a favor de Node por sus runs atascados). Titulares ola 2: start 209 runs/s (4.6× Node) con p99 69ms (7.6× menor), list 6.7k req/s @ p95 10ms sobre org de decenas de miles (el peor caso honesto — gracias al índice keyset), diamond 112 DAGs/s, 0 errores, RSS ~22-43MB en un proceso. Los features de la ola no costaron rendimiento: throughput ↑ en los tres escenarios vs F0 |
| 2026-07-31 | T-068 informe | `REPORT-W2.md`: estado F1/F2 por área, la evidencia que más pesa (paridad reproducible byte-idéntica, rendimiento sin regresión por features, loop del operador desde la UI real), 4 chips upstream + 2 hallazgos de compatibilidad cruzada, divergencias vivas que condicionan adopción, riesgos honestos (HA multi-nodo no probado, propiedad del esquema, mensajes pilot-shaped) y recomendación: ola 3 = «plataforma mínima creíble» (audit + limiter en Postgres + catálogo) + primer despliegue supervisado. GOAL DE 30 TICKETS COMPLETO |
| 2026-07-31 | sync ola-3 | Pin actualizado a develop@1ad09028 (2 commits: qualification de proveedor AI + superficies de estado AI del web). CERO migraciones db nuevas; los cambios de `ai-generate-*`/`ai-prompts` de Node se anotan como INSUMO de la ola 4 (T-105: releer la fuente al implementar — el prompt y Best-of-N cambiaron). Merge limpio, suite 13 paquetes verde post-merge |
| 2026-07-31 | decisiones usuario | (1) Limiter: Postgres fail-open confirmado, Redis solo cuando el negocio lo pida. (2) Esquema/migraciones: propiedad pasa YA a herramienta Go pura (goose) — T-188 se ejecuta primero en la ola 3; la decisión previa «drizzle dueño durante las olas» queda reemplazada: drizzle sigue siendo dueño en el repo Node para develop, el PILOT se auto-migra con goose y espeja las migraciones drizzle nuevas en cada sync. (3) Linaje de replay se decide en T-135 leyendo el uso real — ratificado |
| 2026-07-31 | T-188 goose | Propiedad de esquema ejecutada: goose v3 (Go puro) con migraciones EMBEBIDAS en el binario (`janusly-go migrate`), contabilidad en `go_pilot_goose_version` (sin chocar con drizzle), baseline = dump completo al pin con TRES saneos aprendidos a golpes: (1) meta-comandos psql `\restrict` del dump PG18 no son SQL, (2) el `set_config('search_path','')` del dump rompe el INSERT de versión de goose, (3) `SET transaction_timeout` es PG17+ y el floor es 15. Base pre-goose se estampa (versiones 0+1) sin re-ejecutar; base fresca 74/74 tablas y suite verde SIN el repo Node; pg15 lane 13 paquetes por el camino nuevo; boot rehúsa des-migrado. El probe legacy de drizzle (F0) quedaba FALSO-NEGATIVO en bases goose (tabla drizzle existe vacía) — reemplazado. Regla §0 ampliada: cada sync espeja migraciones drizzle nuevas como goose numeradas; `pnpm migrate` PROHIBIDO sobre bases goose |
| 2026-07-31 | T-069 cadena | `internal/auth` portado de auth.ts: cadena de proveedores en el orden de la referencia (supabase → service-token → dev-headers; el proveedor janusly-session/SSO queda con Node), `principal` privado del paquete, y la resolución donde EL GRANT ES LA FILA org_members (hint = selector de alcance). Invariantes verbatim: compare de service-token en tiempo constante, un Bearer que falla verificación JAMÁS cae al siguiente proveedor, Supabase hardcodea source web (un browser no puede auto-declararse MCP), boot-gate de producción con el mensaje exacto. El 401 del pilot ahora usa la forma Node (`server_request_failed` + "Unauthorized: missing Supabase JWT or dev headers") — antes decía `unauthorized`/"Unauthorized" (divergencia corregida). Supabase se verifica por HTTP directo (`GET /auth/v1/user`, lo mismo que hace el SDK) — sin SDK. Rutas de aprovisionamiento (backfill legacy, invitaciones, dominios verificados, JIT SSO) quedan con la referencia por ahora |
| 2026-07-31 | T-070 supabase | Modo Supabase completo: verificación por HTTP contra `/auth/v1/user` (semántica idéntica al SDK), email en el principal, y el paso 2 del resolver — backfill perezoso de huérfanos legacy (fila con userId=email placeholder → se reescribe al UUID del proveedor en el primer sign-in real y el grant se acepta; el audit `member.userid.migrated` llega con el retrofit T-081). Matriz de fallos cerrada probada: token forjado/expirado, JSON roto del Auth API, outage 500 — todo falla cerrado sin cascada. Precisión vs la card: membresía ausente es 401 (resolver→null→dispatcher), no 403 — la fuente manda. Aprovisionamiento (invitaciones 5a, dominios verificados 5b, JIT SSO 5c) sigue diferido a T-076+/referencia |
| 2026-07-31 | T-071 escalera de rol | `ResolveMemberRole` portado con las TRES sutilezas de la referencia: (1) el literal de la fila gana en TODO modo — el auto-grant admin de dev-headers aplica SOLO cuando NO existe fila (un viewer sembrado es viewer aunque entre por dev-headers); (2) service-token y supabase JAMÁS auto-elevan; (3) un literal custom sin fila `org_roles` que lo defina falla cerrado incluso en dev (la postura de Node para un rol custom borrado con miembros que aún lo referencian) — la rama de herencia custom llega con T-074. Rank viewer<editor<admin en `auth.Rank`, listo para T-072 |
| 2026-07-31 | T-072 catálogo | Las 41 claves EXTRAÍDAS mecánicamente de la fuente (regex sobre permission-catalog.ts, no transcripción a mano) → `auth.PermissionCatalog` con test que ancla conteo exacto (41), 20 categorías activas, todo defaultRole built-in, y 9 filas ancla de la matriz (workflows.read viewer sí / write viewer no, members.write solo admin, etc.). `requireRole` como helper de core (ambos wires) con el 403 verbatim de Node ("Forbidden: requires <role> role" bajo server_request_failed); primer uso real en saveCore — un viewer sembrado NO guarda ni por dev-headers, el fantasma del mismo org sí (auto-grant solo-sin-fila probado por el gate HTTP real) |
| 2026-07-31 | T-073 registry | Enforcement CENTRAL en el middleware vía `http.Request.Pattern` (Go 1.22): una sola tabla anotada (`routeAuthz`, 40+ patrones con los pares role/permission de Node extraídos de sus registries) indexada por el patrón matcheado — un mount no puede olvidar sus gates, y el orden es el del dispatcher Node (requireRole → requirePermission). Rechazos wire-aware (envelope en /v1, raw en legacy). 403 de permiso verbatim ("Forbidden: requires permission <key>"). Correcciones de datos sobre mi extracción inicial: GET /org/config va SIN gate (solo auth; el POST es admin+org.config.write) y /resume usa runs.start (no runs.write). El sweep de completitud RECORRE la tabla: viewer sembrado → toda mutación editor 403 con mensaje exacto, toda lectura pasa ambas capas (los 403 del dominio como runs_forbidden distinguidos por código); capa de permiso probada independiente (editor con rank suficiente pero sin members.write → 403 de permiso) |
| 2026-07-31 | T-074 roles custom | La escalera completa org_roles-aware: rango custom vía `inheritsFrom` del enum cerrado (fuera del enum o fila borrada → cerrado), y `EffectivePermissions` con la búsqueda exacta de Node — grants no-nulos REEMPLAZAN el set default (no aditivo), custom con permisos null = bug de integridad → set vacío fail-closed, y un override de BUILT-IN con grants no-nulos también reemplaza (el org que estrecha editor a solo-lecturas). requirePermission consulta la capa org-aware en caliente; claves fuera del catálogo en un grant list se descartan silenciosamente |
| 2026-07-31 | T-075 anti-lockout | `CoerceAdminFloor` portado: todo override del admin BUILT-IN fuerza `org.permissions.write` + `members.write` devolviendo las claves coercidas (el audit las registrará en metadata.coerced vía T-077); idempotente si ya están; los custom con rango admin (billing-admin) deliberadamente NO se coercen — un admin estrecho a propósito es legítimo. Las rutas que lo consumen llegan en T-077 |
| 2026-07-31 | T-079+T-080 audit | Chokepoint completo en `internal/audit`: catálogo cerrado de acciones extraído mecánicamente — la unión real tiene 147 acciones, NO las 88 de mi primera extracción (el `;` intermedio cortó el union type; la re-extracción line-a-line lo destapó) — con acciones pilot-propias en registro separado para que el pin de paridad quede exacto. Tres escritores con las posturas de la referencia: `Write` best-effort (fallo se loguea y se traga — telemetría jamás rompe la operación; una acción con typo NO inserta), `SystemWrite` (actor sistema, org "system" sentinel), y `WithAuditTx` donde la firma del compilador impone lo que Node solo podía imponer por convención de sombreado — el handler recibe el audit LIGADO al tx, entidad+audit comprometen o revierten juntos, y un typo AHÍ falla la tx (el pairing existe para fallar). Metadata: bloque actor/source derivado del auth GANA la colisión (un caller no puede forjar la forense) + redacción de claves sensibles antes del jsonb |
| 2026-07-31 | T-076 members | Las 6 rutas de members con los wire shapes verbatim: escalera de invite (rol definido para el org — built-in O custom vía getOrgRole —, formato de email, 409 invitación-pendiente, 409 miembro-existente por email), revoke de invitación (404 en no-pendiente, una sola vez), cambio de rol (guard de auto-modificación AUDITADO con la intención cruda del operador — action role_set/remove distingue las dos superficies —, 404 en miembro fantasma sin auditar cambios fantasma), y el delete SIN cascada (solo la fila; workflows/runs/audit quedan). Mejora sobre Node anotada: las mutaciones van por WithAuditTx (entidad+audit juntos) donde las rutas de la referencia auditan post-hoc best-effort. Gates del registry: members.read / members.write / members.role_set con los rangos de Node |
| 2026-07-31 | T-077 roles CRUD | Superficie completa: catálogo (41 claves + piso obligatorio), lista con built-ins VIRTUALES hasta override, create con su escalera (gramática de nombre, nombre built-in → 400 hacia el camino de override, clave desconocida, 409 duplicado), update dual (override de built-in con fila upsert en el primer override + inheritsFrom INMUTABLE en built-ins; edición custom con previousInheritsFrom en el audit), piso admin coercionado y AUDITADO en metadata.coerced, y la escalera de delete (built-in revierte con `{ok, reverted}`; custom con miembros → 409 `role_in_use` con membersAffected en el TOP del envelope; sin override → 404 `roles_override_not_found`). El test probó el efecto VIVO por los gates reales: el auditor lee DLQ pero no workflows (reemplazo), y — la joya — tras estrechar el admin a una clave, el piso coercionado dejó al propio admin revertir el override y expulsar miembros: el anti-lockout funcionando de punta a punta sin habérselo pedido al test |
| 2026-07-31 | T-078 boot gate | Gate cableado al main y probado con PROCESO real: `JANUSLY_GO_ENV=production` sin Supabase → exit 1 con el mensaje verbatim de la referencia; con `ALLOW_DEV_AUTH_HEADERS=true` explícito arranca y responde `/healthz`. RUNBOOK con las 4 envs nuevas de auth |
| 2026-07-31 | T-081 retrofit de audit | Las 18 mutaciones de olas 1-2 auditan con los nombres exactos de la referencia: save/rollback/delete/restore, start adhoc/resume/cancel/redrive, dlq.replayed, trigger received/buffered/started, campañas created/cancelled. El pump audita item_replayed/item_failed (actor = creador) y completed (actor `system:replay-campaign`) |
| 2026-07-31 | T-081 catálogo — hallazgo | `recovery.campaign.completed`/`item_replayed`/`item_failed` existen en la referencia pero los escribe su system-writer SIN tipar (fuera del catálogo `AuditAction` de 147) — se admiten vía `RegisterPilotAction` sin tocar el pin de 147 |
| 2026-07-31 | T-081 identidades | El MCP server (escritura directa a store) audita con `Mode=service-token, Source=mcp`; un start por trigger NO es `run.started.adhoc` (0 filas verificadas); el retry convergente del relay no re-audita |
| 2026-07-31 | T-082 GET /audit | Lector del rastro: wire crudo `{rows, nextCursor, hasMore}` de la referencia, filtro PREFIX de acción, keyset `(createdAt,id)` DESC con cursor `<iso>|<id>`, tope 200/default 100, gate admin + `org.config.write` en el registro central. Test: 5 filas en loop apretado (colisiones mismo-ms reales) reensambladas en páginas de 2 sin saltos ni repes |
| 2026-07-31 | T-082 precisión ms | Postura T-058 extendida a audit: `created_at` se estampa app-side truncado a ms para que el cursor ms haga round-trip exacto (la referencia mantiene µs en DB y cursor ms — puede saltar pares del mismo ms en fronteras de página; el pilot es estrictamente más correcto, wire idéntico) |
| 2026-07-31 | T-083 chokepoint formal | `grammar.SafePersistPayload` con las 3 capas de la referencia: redacción por VALOR (lista opcional), por CLAVE (siempre; el mismo `IsSensitiveKey`, sin bifurcar), y cota de bytes (default 256 KB, env `JANUSLY_PERSIST_MAX_BYTES`, `PersistUnbounded` para los snapshots DLQ) con el centinela `{__truncated, originalBytes, maxBytes, preview}`. `engine/bound.go` queda de shim (mismo split que la referencia); el metadata de audit migró y GANÓ la cota que no tenía |
| 2026-07-31 | T-083 property test | Corrida sembrada con secretos (claves sensibles en output de transform + Authorization/password en config del http que muere a DLQ): barrido de las 6 columnas jsonb del chokepoint — cero supervivencias; el snapshot DLQ conserva estructura reproducible con `[redacted]` en su sitio |
| 2026-07-31 | T-083 hallazgo test-only | Un literal `domain.Workflow{}` sin `DSLVersion` produce un snapshot que el propio `workflowFromRunInput` no puede re-interpretar (Parse exige "1.0"); la ruta API siempre lo estampa — mal uso exclusivo de tests engine-direct, documentado aquí |
| 2026-07-31 | T-084 limiter Postgres | La decisión del operador ejecutada: ventana fija por `(name,key,window_start)` en `go_pilot_rate_windows` (goose 00002; ventana EN la PK → un UPSERT O(1) por request, expiración por DELETE — sin vacuum-storm), FAIL-OPEN con warn ante fallo del store, hooks panic-absorbentes, 429 con el mensaje verbatim de Node. `CleanupExpired` listo para la cadencia de mantenimiento (se cablea en T-085) |
| 2026-07-31 | T-084 degradación | Tracker en memoria + audit `rate_limit.degraded` UNA vez por (bucket, día-UTC) con dedupe en DB probado con dos réplicas (instancias con memoria fresca), `recovered` one-shot, snapshots public/admin listos para T-091. Matiz honesto documentado: el store auditado ES el store que falla — en pleno outage la señal superviviente es el snapshot en memoria (idéntico rol al del tracker de Node) |
| 2026-07-31 | T-084 metadata sin actor | Las filas de degradación de la referencia no llevan campo `actor`; `SystemWrite` ahora omite el actor vacío para paridad byte-igual de metadata |
| 2026-07-31 | T-085 limiter cableado | Storm-guard por trigger (bucket `trigger.<versionId>.<nodeId>`, clamp [1,10000] default 60, orden Node received→guard→buffer): sobre el límite → fila `skipped` + audit `trigger.event.skipped` con `ratePerMin` + 429 `{ok:false,skipped:true,reason:"rate_limited"}` — cierra la divergencia de T-040. MCP writes con el `guardMcpWrite` de la referencia: bucket `mcp.<tool>` 60/min por org (mensaje verbatim del limiter como tool error). Limpieza de ventanas expiradas en la cadencia del sweep de retención |
| 2026-07-31 | T-085 hallazgo | El punto (1) de la card era especulativo: Node NO limita start/save/resume — sus buckets reales son `"ai"` (rutas AI, aún no portadas) y `mcp.rediscover`; cablear límites inventados habría CREADO divergencia. Los buckets `ai` llegan con la ola que porte `/ai/*` |
| 2026-07-31 | T-086 catálogo org config | Las 69 definiciones extraídas mecánicamente de `orgConfigCatalog.ts` (la card estimaba ~50) a `internal/orgconfig`: claves/tipos/defaults/envKeys/min-max/allowedValues/allowEmpty/fractional + guards de nombre y valor prohibidos verbatim. Resolutor por capas puro (fila válida → env → default; valor inválido cae a la SIGUIENTE capa, nunca aplica a medias). GET lista el catálogo completo con procedencia (el stub `[]` de T-043 era una divergencia — la referencia responde el catálogo entero a una org fresca); POST valida por el pipeline y audita |
| 2026-07-31 | T-086 validadores diferidos | 5 claves llevan validador custom en Node (surfaceModels, operatorGuidance, memory.allowedKinds, memory.retentionDaysByKind, recovery.slaPolicies) — sus subsistemas no existen aún en el pilot; marcadas `HasDeferredValidator`, el pipeline estándar les aplica igual y el custom llega con su ola |
| 2026-07-31 | T-087 consumidores | El catálogo gobierna: `runs.requireSavedWorkflow` en `/start` (403 `runs_adhoc_disabled` con mensaje byte-igual; el chequeo saved-vs-adhoc además CORRIGE el audit de T-081 — un start de workflow guardado ahora audita `run.started`, no `.adhoc`), `mcp.writeConsent` migrado del lector puntual al snapshot (T-057 verde encima), retención de tombstones POR ORG con la ventana del catálogo (org a 1 día purga, org a default 30 conserva — probado con dos orgs), `/health` reporta el snapshot real del tracker del limiter (el hard-coded "healthy" ya mentía). Lector del TTL de human-form disponible vía `LoadNumber` (se consume en ola 4) |
| 2026-07-31 | T-088 retención completa | run_events (vía run padre — la tabla no tiene org) / audit_logs / usage_events con el patrón subquery+LIMIT de la referencia: por org con su ventana del catálogo, `hold_until` exento, lotes acotados (defaults 10k×1000) y shape de resultado `{rowsDeleted, cutoffAt, runtimeMs, cappedByMaxBatches}` — un barrido capado sigue drenando a la hora siguiente. Probado con volumen sembrado: 250 filas a lotes de 100 con tope 2 → 200 capado, la siguiente pasada drena 50; org de ventana ancha intacta; el legal hold sobrevive |
| 2026-07-31 | T-088 rendimiento | La enumeración de orgs se acota por los PISOS del catálogo (run_events ≥7d, audit/usage ≥30d — una org con solo datos frescos ni entra al loop) y las ventanas se leen en UNA consulta (`retention.%`) resuelta en memoria: el primer intento iteraba todas las orgs con 6 consultas por org (40 s en el DB de dev) |
| 2026-07-31 | T-089 sustrato usage | `internal/usage`: Record con el contrato de la referencia (tokens con puntero para distinguir 0 de ausente, costUsd nil = modelo sin precio, providerSimulated, mode ai/fallback), seam process-global `SetRecorder`/`Fire` (equivalente de `setUsageRecorder`) registrado en el boot del api, y el escritor DB con la fila exacta: `metric:"llm.completion"`, quantity=totalTokens, metadata con NULOS EXPLÍCITOS para forma estable. Fire absorbe recorder ausente/org ausente/error/pánico — la telemetría jamás rompe la llamada. Listo para el LlmClient de T-101 |
| 2026-07-31 | T-090 /run/usage + costos | El stub honesto de T-032 reemplazado: `GET /run/usage` con el shape de la referencia (guardas runId/403, slice acotado 10k DESC NULLS LAST, agregado llm con knownCostUsd/unknownCostCalls + memoria por kind ordenada por actividad) y el rollup de costos en `/recovery/metrics` (`costByProvider`): agregación de la VENTANA COMPLETA en Postgres, ranking por valor, tope 100 grupos proveedor/modelo + UNA fila resto `__other__` con `aggregated:true` — totales exactos probados con 105 modelos sembrados (cada dólar aterriza en alguna fila, jamás sample crudo) |
| 2026-07-31 | T-091 health dos niveles | `/health` público: `rateLimiter` truncado + `queue:{degraded}|null` (nunca números vivos — probado por negación de claves); `/system/queue` admin con la forma Node (`waiting/active/oldestWaitingSeconds/warnSeconds` + `maintenance:null` explícito — el pilot corre mantenimiento in-process, sin segunda cola); `/system/rate-limiter` admin con el snapshot de triage. Snapshot coalescido 5s con timeout duro de 2s (éxito Y fallo cacheados); fallo del store → `queue:null` con `ok:true`. `JANUSLY_QUEUE_LAG_WARN_SECONDS` 1..86400 default 60 |
| 2026-07-31 | T-091 edad por elegibilidad | La edad del más viejo corre desde la ELEGIBILIDAD: `GREATEST(último evento node.queued, wake_at del retry)`; un nodo sin ninguna señal queda con edad desconocida y se EXCLUYE — el análogo honesto del matiz BullMQ de la referencia ("previously processed work exposes unknown age"), documentado en la propia query |
| 2026-07-31 | T-092 Prometheus paridad | Series con los NOMBRES de la referencia junto a las janusly_go_* propias: `workflow_queue_waiting_jobs`/`_active_jobs` (collector cacheado 5s sobre la MISMA query de elegibilidad de T-091), `janusly_rate_limit_degraded_buckets` (gauge process-global alimentado por transiciones simétricas del tracker), y el Resource OTel renderizado a la manera Prometheus: `target_info{service_name="janusly", service_namespace="janusly", service_instance_id}` (env → HOSTNAME → os.Hostname). Bind 127.0.0.1 y arranque post-migraciones ya existían; conflicto de bind PROBADO con proceso real: exit no-cero, jamás media superficie servida |
| 2026-07-31 | T-093 lane HA | `make test-ha` (tag `integration && ha`): DOS engines con pools separados sobre la misma base. (1) 75 DAGs de propiedad (25×3 rondas, starts repartidos entre instancias) con los invariantes exactly-once/orden/sin-huérfanos del arnés mono-instancia intactos; (2) una campaña drenada por AMBAS bombas: cada item asentado una vez, cada dead letter de la cohorte con exactamente un claim, UNA sola auditoría de completion (el CAS status='running' elige un ganador); (3) 40 timers de retry masivos (80 wake-ups) sin duplicados ni fugas. Verde ×3 corridas |
| 2026-07-31 | T-093 hallazgos del arnés | Dos trampas del PROPIO test, no del motor: un literal sin `Edges: []` marshala `null` y el snapshot no re-interpreta (falla instantánea no-reintentable — mismo hallazgo que T-083 desde otro ángulo); y el revive-in-place de un replay contra un target aún muerto acuña dead letters NUEVAS abiertas — el assert de claims debe mirar la cohorte original |
| 2026-07-31 | T-094 matriz de bombas | Los 5 loops de fondo revisados y probados con gemelo simultáneo: workers (escalera de claim — T-093), bomba de campañas (claim atómico de despacho — T-093), timers (wake-up en la fila — T-093), reaper (el CAS de FailNode elige un ganador — 2 reapers sobre 5 varados = 5 DLQs exactas), retención (DELETEs idempotentes — 2 barridos suman 300/300 sin doble conteo). NINGUNO necesita lease a escala pilot; el RUNBOOK gana la sección HA con la matriz completa y el punto de corte exacto (advisory lock por loop) si el negocio lo pide |
| 2026-07-31 | T-096 contrato v1 | Manifiesto puro `internal/contract` (20 rutas /v1 con shapes de request/response; el generador JAMÁS importa el server — paridad con la regla V1_CONTRACT_ROUTES) → `cmd/contract` renderiza determinista a `contract/openapi.json` (OpenAPI 3.1) con los envelopes de éxito y error documentados UNA vez en components y referenciados por cada operación. Guard de deriva en `make ci` probado de verdad: manifiesto tocado sin regenerar → diff → falla |
| 2026-07-31 | T-097 lane CI | Job `test_go` en `.github/workflows/ci.yml` sobre los MISMOS triggers (cero pushes extra): service container `pgvector/pgvector:pg18` directo (sin Compose en el YAML — regla del repo), setup-go con cache por go.sum, golangci-lint 2.12.2 anclado, migrate goose y `make ci` (drift sqlc + drift contrato + build + lint + suite -race + paridad). Validado localmente con el MISMO comando; el verde en push real queda para el próximo batch de push del usuario (repo privada — cada push cuesta) |
| 2026-07-31 | T-097 hallazgo operativo | `make ci` NO puede correr concurrente con `make soak` sobre el mismo DB dev: el binario del soak (poll 50ms) roba claims de los tests de engine — 7 fallos ambientales, cero regresiones. En CI no aplica (DB efímero por job); localmente, un lane a la vez |
| 2026-07-31 | T-095 soak 1h | `make soak` (k6 sostenido parametrizable + muestreo de /metrics interno) corrió la HORA completa: 121 muestras, veredicto ESTABLE en las tres señales — RSS 32.5→33.2 MB (+2.2%), goroutines 42→40 (−4.6%), heap 9.7→9.9 MB (+1.8%). El arnés falla el make target con crecimiento >10% primer-cuarto vs último-cuarto; reporte direccional en `conformance/perf/SOAK.md` + serie `soak-ms93ees6.jsonl`. Hallazgo del arnés: k6 debe correr ASYNC (execFileSync mataba de hambre al muestreador) |
| 2026-07-31 | T-095 residuo del drain | Un SIGTERM al binario del soak deja nodos `pending` de runs en vuelo (el drain termina lo RECLAMADO, por diseño) — ese residuo interfirió un test de shutdown de la suite hasta limpiarlo. Nota operativa: tras un soak local, cancelar los runs `soak-%` restantes antes de correr la suite |
| 2026-07-31 | T-098 REPORT-W3 | Cierre de ola con la misma vara: qué es ahora la plataforma (multi-tenant operable con esquema propiedad de Go), matriz de authz, evidencia que más pesa (lane HA ×3, property de secretos, el piso que se probó solo, base fresca sin Node), soak 1h estable (~33 MB RSS), 7 divergencias deliberadas cortadas, deuda consciente y recomendación de ola 4 (arrancar por T-101 LlmClient). 31/31 de la ola; 100/100 acumulados en el plan |
| 2026-07-31 | sync ola-4 | Pin actualizado a develop@103be9e8 (12 commits). DOS migraciones drizzle nuevas espejadas como goose 00003 (índices keyset compuestos de listas) + 00004 (sweep NULLS FIRST — el hallazgo del memory de drizzle, ahora en la referencia); aplicadas al DB dev. `usage_events` NO entró en el sweep (el `NULLS LAST` de ListRunUsageSlice sigue correcto) y el lector de audit ya usaba DESC plano — alineado con el índice nuevo sin cambios. Cambios de `v1 contracts split by domain` + `typed executor dispatch` + `scripted-node testkit` de Node anotados como INSUMO de la ola 4. Merge limpio; suite 17 paquetes + lint verdes post-merge |
| 2026-07-31 | sync ola-5 | Pin actualizado a develop@dfde6a31 (3 commits, refactors puros: split del catálogo/dispatch MCP, split de persistencia del engine por lifecycle, split del schema db por dominio). CERO migraciones drizzle nuevas → sin espejo goose (la promesa "refactor puro no genera migración" se cumplió). Merge limpio; build Go verde post-merge. Los splits de la referencia son INSUMO de lectura para la ola 5 (persistence-ports/run.ts etc. ya están en su layout final) |
| 2026-07-31 | sync ola-6 | Pin actualizado a develop@7f0e286b (3 commits, refactors puros: split de run-routes por responsabilidad, split de recovery-metrics del data layer, split de integration-tools por proveedor). CERO migraciones drizzle nuevas → sin espejo goose. Merge limpio; build Go + paridad 26/26 verdes post-merge (un FAIL transitorio no reproducido ×4 — segundo avistamiento del flake, anotado). Los splits de integration-tooling/{slack,pagerduty,webhook}.ts son INSUMO directo de la ola 6 de integraciones |
| 2026-07-31 | dirección estratégica | Johnny decide incluir TODO en el alcance (SCIM T-191..T-194 + experiments T-189/T-190): la convicción es que el futuro del proyecto es Go — el pilot deja de ser solo una puerta go/no-go y pasa a ser la base de código definitiva para abandonar Node. El mapa strangler (T-184) pierde las exclusiones permanentes: responde cuándo migra cada ruta, no si migra. Ola 6 queda en 35 tickets (T-159..T-194) |
| 2026-07-31 | T-099 LlmClient | `internal/ai.Client` sobre anthropic-sdk-go v1.61 con el contrato sagrado EN la frontera: cualquier fallo del SDK → `*AIError` clasificado (no_client/auth/rate_limit/overloaded/timeout/network/invalid_request/unknown), mensajes acotados a 500 bytes, y un `recover` diferido como última línea — ni un pánico del SDK llega al caller. Interfaz neutral de proveedor; hint `"<provider>/<modelo>"` con proveedor ajeno → invalid_request sin marcar. Matriz probada contra servidor falso (401/403/429/529/500/400/timeout/endpoint muerto/sin clave) + shape de éxito con passthrough de cache tokens + test de frontera: NINGÚN paquete fuera de internal/ai importa el SDK (walk del módulo completo) |
| 2026-07-31 | T-100 config AI | `internal/aiconfig` (el análogo del ai-runtime de Node; `internal/ai` queda DB-agnóstico como packages/ai): resuelve del catálogo `ai.provider`/`ai.anthropic.model`/`ai.timeoutMs`/`ai.maxRetries`/`ai.maxOutputUnits` + settings externos (`promptMaxChars`, `rateLimitPerMin`). Clave API SOLO de env; sin clave → cliente sin configurar → todo cae a no_client (la postura $0). Tenant en proveedor ajeno → cliente sin configurar AUNQUE haya clave Anthropic (fallback, jamás re-ruteo silencioso). `TruncatePrompt` acota sobre el máximo cortando en frontera de runa (postura documentada, no error). Simulador tras el DOBLE gate explícito de la referencia |
| 2026-07-31 | T-101 usage del chokepoint | Una fila por INTENTO (éxito Y fallback) vía el Recorder de T-089, disparada dentro del propio GenerateText: fila `ai` con tokens+cache+`costUsd` calculado de la tabla portada (`pricing.go`: snapshot 2026-04 + override `JANUSLY_LLM_PRICE_<MODEL>` con la gramática exacta), fila `fallback` con el aiError clasificado y costo nulo. Modelo desconocido → costUsd null (jamás inventado); simulador → costo CERO aunque el modelo tenga precio. Matiz honesto: el "fallback defensivo a metadata de Anthropic" de Node no aplica — aquí el SDK ES Anthropic y los cache counts vienen tipados directos |
| 2026-07-31 | T-102 caching + maxOutputUnits | El contrato probado EN el wire con servidor de captura: `CacheSystemPrompt` pone `cache_control:{type:"ephemeral"}` en el bloque system del request (opt-out → request sin marcar byte a byte; sin system → no-op, jamás error), `MaxOutputUnits` per-call llega como `max_tokens` (777 verificado vs default 4096). Los conteos de cache ya fluían a usage desde T-101 (read 2 / creation 1 passthrough probado). El plumbing venía de T-099 — este ticket lo ancló al wire |
| 2026-07-31 | T-103 presupuesto | `internal/aibudget` con el Check/Gate de la referencia: agregado mensual de `costUsd` por org contra `ai.budgetMonthlyUsd`, `allowed=false` SOLO con policy `block` + límite cruzado; `warn` procede con audit `billing.budget.warned` dedupeado a 24h; CADA bloqueo audita `billing.budget.exceeded` (deliberadamente sin dedupe — la card decía "una vez por transición" pero la referencia audita cada bloqueo con comentario explícito; se porta la referencia). Fail-soft: suma rota → gate ABIERTO. `GuardedGenerateText` es la composición canónica: gate primero, bloqueado → `budget_blocked` con CERO hits al proveedor (probado con contador atómico). Alcance org (workflow_budgets diferido con su superficie). `audit.WriteAs` nuevo: fila con user_id de columna sin enriquecimiento, como el audit() crudo de Node |
| 2026-07-31 | T-104 free_json | `ExtractJSONObject` porta la gramática exacta de la referencia (fences + slice de llaves externas) con sus 3 casos 1:1, y `ParseJSONValue` añade el hardening de la card ENCIMA: BOM tolerado, arrays top-level, y reparación acotada de JSON TRUNCADO (walker consciente de strings/escapes que cierra lo abierto; `"key":` colgante → null; coma final recortada; un texto YA balanceado que no parsea es fallo semántico y NO se "repara"). Entradas sin remedio → (nil,false), jamás pánico — fuzz de 1000 cadenas con piezas LLM-shaped (fences anidados, BOM, NUL, prefijos válidos) re-marshaleando cada éxito |
| 2026-07-31 | T-105 /ai/generate-workflow | La superficie completa en modo free_json: cap de prompt (413 `ai_prompt_too_long`), bucket "ai" del limiter, gate de presupuesto (402 con envelope), system prompt de 21KB embebido VERBATIM (extraído mecánicamente de ai-prompts.ts), escalera free-JSON (2 intentos con nudge de parse + preservación byte-igual de referencias `{{...}}` del operador), validación con el validador REAL del dominio (postura save: tipos pilot-unsupported no bloquean), reparación dirigida (2 intentos con los issue codes exactos + el draft), y el wire `{mode, ...workflow}`. Fallback determinista: las 5 plantillas de la referencia verbatim + el matcher de palabras clave en su orden exacto (email primero) — SIN aiError cuando no hay clave (el contrato de skip de evals), CON aiError clasificado cuando el intento LLM degradó |
| 2026-07-31 | T-105 evals contra Go | `node scripts/run-evals.mjs` con `JANUSLY_EVALS_API_URL` al binario Go: **3 passed, 0 not-passing, 27 skipped, exit 0** — deterministas 100% con los 3 templates anclados por id, ai-mode saltado limpio a $0. Diferidos a sus tickets: Best-of-N (T-106), exemplars/guidance (T-107), PromptOps (T-108), promoción noop pass-2 y la receta PagerDuty (divergencia §9: presupuesto bloqueado + prompt PagerDuty → 402 aquí, receta en Node) |
| 2026-07-31 | T-106 Best-of-N | `ai.generationCandidates` clampeado [1,5]; N muestras PARALELAS (goroutines; una muestra rechazada se descarta, jamás fatal), selección con el scorer exacto de Node (readiness fails×10 + warns, menor gana, empate estable al primero), cero candidatos válidos → el primer parseado va al repair tail (no directo a fallback), cero parseados → escalera single-shot. Backoff cost-aware: umbral de warn del presupuesto cruzado → colapsa a 1 con audit `candidates_backoff`. N=1 NO toca la rama BoN — el camino simple queda byte-igual. Probado: 3 muestras con 1 sola válida → gana la válida, 3 llamadas reales al proveedor, telemetría `{candidateCount:3, validCandidates:1}` auditada |
| 2026-07-31 | T-107 janusly.md | `internal/aiguidance` con las primitivas de la referencia: dos alcances (org del catálogo `ai.operatorGuidance` + workflow de `workflow_metadata.ai_guidance_markdown`, best-effort), scrub de las 5 familias de secretos de guía ENCIMA del scrub compartido, normalización de saltos + control/invisibles→espacio, cota 8KiB por alcance / 12KiB combinada con la matemática de donación (un alcance corto dona su sobrante; la guía de org JAMÁS borra la sección de workflow). SIEMPRE DATA-framed: header + líneas `| ` + cláusula de escape al cierre — el fixture de instrucción maliciosa queda enmarcado como datos. Inyección SOLO donde Node inyecta (system prompt de generación, incluida la rama BoN); guía vacía → prompt base byte-igual |
| 2026-07-31 | T-108 PromptOps | Hallazgo primero: en la REFERENCIA el registro NO alimenta el system prompt de generación (eso es literal) — sirve los `promptRef` de los nodos `ai` vía el prompt-resolver del engine; la card era especulativa y se portó la realidad. `internal/prompts`: ResolveActive (pinned gana, si no la última published, fall-through defensivo), ResolveTemplate con los DOS pases del resolver — `{{include.Y}}` depth-first con set de visitados contra ciclos y tope 8, `{{var.X}}` con required fallando ANTES de gastar tokens; lo demás pasa intacto al sustituidor del engine. Rutas create/version/pin/list con shapes y códigos de Node + retry acotado de numeración + 3 audits. Probado el hot-swap: pin de v1 cambia el prompt activo SIN redeploy; registro ausente → ErrPromptNotFound (la señal de fallback al literal del consumidor T-111) |
| 2026-07-31 | T-109 /ai/patch-workflow | El AI-patch del Recovery dialog: gate de presupuesto + bucket ai + DLQ tenant-scoped, envelope de CONFIG (reemplazo completo del config del nodo fallido) con despacho al envelope ESTRUCTURAL (insert_approval_upstream con recableo de aristas) cuando el nodo es write-side http/mcp_tool sin ancestro de aprobación — el mismo clasificador del readiness. Cada sugerencia se APLICA y valida con el validador real: una inválida JAMÁS llega al wire (probado: config sin url descartada, la válida sobrevive sola). 0-2 alternativas one-line con el scrub apilado (sk-ant sobrevivía con ScrubSecretShapes solo — corregido a ScrubGuidanceSecrets), SEPARADAS de evidence (siempre []). Fallback determinista con la forma COMPLETA (suggestion con los 7 campos + passport con firma real). Diferidos con sus subsistemas: calibración (calibrated espeja raw — el comportamiento disabled), memoria/feedback/locale |
| 2026-07-31 | T-110 evidencia AI | Hallazgo: la card decía "persistido" — la referencia es un canal de RESPUESTA (proyección determinista de lo que el compositor del prompt ya juntó, sin segunda llamada LLM ni tabla). `internal/aievidence`: 6 kinds cerrados, scrub de LECTURA (re-scrub de secretos, colapso de control, caps 400/120/200 en RUNAS — semántica de length JS, no bytes —, weight clampeado [0,1], filas sin snippet descartadas, lista acotada a 24). Cableado al patch en AMBOS caminos (ai y fallback) con builders deterministas recent_error + signature_rule; el audit lleva SOLO evidenceCount — las filas jamás tocan la fila de audit. Probado: cotas, scrub, kinds desconocidos descartados, y que las alternativas no se filtran al canal |
| 2026-07-31 | T-111 nodo ai | Executor con la semántica exacta de Node: promptRef (PromptOps, gana sobre inline con evento de ambigüedad; fallo del resolver → fallback ANTES de gastar tokens), prompt del config renderizado, eventos ai.prompt/prompt_resolved/fallback/budget_exceeded/output_invalid, system fijo + prompt = JSON{prompt, context}, salida estable {mode, response, model, usage, costUsd, latencyMs} — y la regla sagrada PROBADA en 4 escalones: sin proveedor el run SUCEDE con fallback sin aiError, proveedor vivo → mode ai con template renderizado + costo cero simulado, réplica de validación (ReplayMode nuevo en StartInput→runs.replay_mode) JAMÁS marca el SDK (contador), proveedor muerto → el nodo COMPLETA con aiError y el run sucede. outputSchema: valid/data con chequeo a nivel parse (validación de subset de schema diferida — §9). Dispatcher construye AIDeps (cliente por catálogo + budget fail-soft + resolver PromptOps + dryRun) |
| 2026-07-31 | T-112 memoria pgvector | `internal/memory` sobre la `memory_entries` compartida (vector 1024): cliente de embeddings Ollama bge-m3 (base URL catálogo→env→default; bypass deliberado del guard SSRF — config de infraestructura del operador, jamás input de autor), consent de DOS flags + kind en allowlist (los 7 kinds cerrados con sus retenciones por kind — retain_until verificado ~180d), Commit/Recall que JAMÁS lanzan (toda falla degrada ok:false/vacío con fila de usage best-effort), recall con orden de similitud `<=>`, tope de entradas Y de bytes del catálogo, y runId reenviado en cada fila `memory.commit`/`memory.recall` (la atribución que /run/usage ya agrega desde T-090). Probado: consent off = cero filas escritas, flag de proceso solo NO basta, kind fuera de allowlist rechaza, Ollama muerto degrada ambos caminos en silencio, round-trip con orden de similitud real |
| 2026-07-31 | T-113 vector tools | `vector.search`/`vector.upsert` como wrappers FINOS (closures MemoryDeps del dispatcher sobre Commit/Recall del sustrato — jamás re-implementan embedding ni DB), kind `workflow_vector` fijo, upsert `WriteSide:true` en el catálogo. Interceptadas en el tool executor ANTES del dispatch genérico (necesitan identidad org/run del engine); vía registro pelado responden "requires engine context". Consent off → `{ok:false, error:"memory_disabled"}` / search vacío SIN lanzar (ambos runs SUCEDEN); réplica de validación → upsert `skipped:true` con cero filas nuevas. Round-trip probado por runs reales: upsert → search lo encuentra |
| 2026-07-31 | T-114 agent loop (reglas) | El bucle plan→tool→observación con presupuesto de pasos y la familia completa de eventos de la referencia (started/step.started/step.planned/agent.reasoning/tool.started/completed/reflection/completed). Planner de reglas VERBATIM (tool explícito → uppercase → pick/extract → http → fallback uppercase con JSON({goal, context})). `http.request` corre por la MISMA maquinaria del nodo http (SSRF/bounds — jamás segunda pila HTTP); `text.uppercase` añadido al registro (catálogo 9→10). Dry-run retira writes EN ejecución (`http.request` POST clasificado write-side; skip probado con cero hits); tipos `ai`+`agent` entran al PilotNodeTypes ejecutable. Probado por runs reales: escalera de fixtures, presupuesto corta exacto en maxSteps, reasoning events presentes. Seam del planner LLM dejado (cae a reglas) — T-115 lo llena |
| 2026-07-31 | T-115 planner LLM | El planner de la referencia completo: prompt JSON{goal, config, context, history, availableTools (proyección del catálogo con writes OCULTOS en dryRun + http.request sintético), requiredJsonShape}, systemPromptRef opcional del registro PromptOps (fallo → prompt hardcodeado en silencio), parse estricto validado contra el catálogo de nombres. Matriz PROBADA por runs reales: sin cliente → reglas con `llm_not_configured`, malformado → reglas, tool inexistente → reglas con atribución exacta, proveedor lanzado → reglas con el aiError clasificado; presupuesto bloqueado → plan `done` terminando limpio (jamás re-dispara el LLM); plan VÁLIDO ejecuta su tool (mode ai) y `done:true` cierra con finalAnswer. El bucle SIEMPRE avanza |
| 2026-07-31 | T-116 memoria episódica | `internal/memory/episodes.go` con la semántica exacta: recall semántico (query=goal) SOLO para el planner LLM configurado (reglas jamás embebe), short-circuit ANTES de cualquier embedding con consent off (probado: cero llamadas al endpoint), bloque DATA-framed con cláusula de escape + scrub + cotas (5 episodios / 300 chars/línea / 4096 bytes) y ranking mismo-workflow-primero; write-back de UN episodio (goal+outcome, 2000 chars) al completar Y al agotar presupuesto, saltado en dryRun. Evento `agent.memory.recalled` SOLO en el camino exacto (plan ai parseado + recall no-vacío): primera corrida graba sin evento, la segunda recalla y emite `{count, fingerprints}` con huellas SHA-256 de 12 chars — el contenido del episodio JAMÁS entra al evento (probado por negación de substring). El sustrato ganó similarity + workflowId en Recall |
| T-117 | `internal/executors/multiagent.go` — crew secuencial/paralelo sobre el mismo `runAgentLoop`; secuencial liga el GOAL de cada agente por agente completado (`{context, previousAgents}` con el root diferido en dispatch); paralelo liga TODO antes de lanzar (nunca difiere); agregación last/all/first/best-effort textual; `continueOnError`; salida `{mode, aggregation, count, finalAnswer, agents}` | `TestMultiAgentCrew` (secuencial: el goal del agente 2 renderiza contra el resultado del 1 — verificado vía evento `multi_agent.agent.started`; paralelo: 2 agentes sin binding tardío) | La referencia solo liga tarde el GOAL del agente — el resto del config del nodo se renderiza en dispatch; el test inicial asertaba sobre `value` (config, no goal) y falló hasta mirar el evento |
| T-118 | `agent.reasoning` alineado al contrato de la referencia: caps 120/160/160/500 runas (`run-events.ts`), `sanitizeReasoningText` (scrub de secretos + control/bidi/ZWSP → espacio + colapso de whitespace), `tool: null` en `finish`, `replacesEventId` con el id exacto del `step.planned` (Emit ahora devuelve el id del evento) | `TestAgentReasoningContract` + `TestSanitizeReasoningText` (caps en runas, flatten, scrub, null-tool, replacesEventId) | El Go emitía caps inventados (80/40/120/280) sin saneo — el contrato es operador-estable, no chain-of-thought; `Emit` ganó retorno `string` (un solo sitio de asignación) |
| T-119 | Maquinaria YA unificada en `recordUnresolvedPaths` (dispatch) — el ticket la prueba en el punto real de binding: `previousAgents` (multi_agent secuencial, vía `in.ReportUnresolved` en `resolveCrewAgentConfig`) e `item` (loop por iteración); grammar dedupe (`trackUnresolved`) + cota `MaxRecordedUnresolvedPaths=20` | `TestDeferredScopeStrictPolicy` (estricta falla DESPUÉS de que el agente 1 completó; leniente emite UN evento deduplicado con el path duplicado en el goal) + `TestLoopItemScopeStrictPolicy` (item.ghost bajo estricta) | Sin código de producción nuevo — la costura `ReportUnresolved` de T-117 ya cerraba el contrato; solo faltaba la evidencia de tests |
| T-120 | `internal/mcpclient` (chokepoint Execute con la escalera: org → conexión enabled/active → descriptor → validación de schema → dry-run write-skip → consentimiento 2 flags → env-refs genéricos + rechazo CRLF → rate-limit fail-open → transporte) + `internal/executors/mcp.go` (nodo fino vía costura `Input.Mcp`, !ok → error para retry/DLQ) + `executors.NewPinnedHTTPClient` (valida SSRF ANTES de construir y el `http.Client` del SDK marca solo la IP pinneada) + sandbox stdio (allowlist `mcp.clientCommandAllowlist`, env whitelist {PATH}+refs, cwd temp fresco, watchdog de vida y cap de stderr vía `exec.CommandContext` cancel — nunca tocar `cmd.Process` desde otra goroutine) | `TestMcpClientHTTPTransport` (matriz SSRF privado+rebinding, llamada real streamable-HTTP al fixture go-sdk, schema, consentimiento, env-ref genérico, usage) + `TestMcpClientStdioSandbox` (allowlist/lifetime/stderr con tail redactado) + `TestMcpToolNodeThroughRun` (nodo por run real, eventos, fallo ordinario) | Las tablas mcp_connections/mcp_tool_descriptors YA estaban en el baseline (espejo drizzle) — sin cwd (temp-dir por spawn) ni headers (los env_refs resueltos SON los headers URL); el catálogo orgconfig ya traía las claves mcp.* canónicas (piso 60s de lifetime → costura SetStdioLifetime para tests); scrub del stderr apilado signature+aiguidance (lección T-109); triplete create+discovery+audit sin tx |
| T-121 | `RunDiscovery` (mismos transportes endurecidos, ListTools cap 200, upsert descriptores enabled=false/writeSide=true, estado active/failed con razón scrubbed 200, SIN tx) + `internal/signature/mcp_sanitize.go` (`SanitizeMcpToolDescription` NFKC → strip bloque de inyección U+200B..U+FEFF → control chars → scrub → cap 300 con elipsis; `SanitizeMcpPromptLabel` cap 120, colapso a `_`) + `ListExposedToolsForAi` (4 flags opt-in, orden estable, caps 60 tools / 20KB, entrada sintética `_truncated`) | Fixtures de inyección del test Node portados (ZWSP en SYSTEM OVERRIDE, RTL override, NFKC decompuesto, español/CJK intactos, secretos, caps) + `TestMcpDiscoveryAndExposure` (descubre 2 tools deshabilitados, fallo con razón acotada, flags, cap 60+_truncated) | Los descriptores descubiertos NUNCA nacen habilitados ni expuestos — el admin opta por herramienta; homoglifos cirílicos pasan por diseño (uso legítimo no-latino) |
| T-122 | Rutas admin `POST /mcp/connections` (stdio fail-closed contra el allowlist, http/sse con URL válida; create + discovery + audit SIN tx) y `POST /mcp/connections/{alias}/tools/{toolName}` (enabled / writeSide / exposeToAi booleanos, rateLimitPerMin tri-estado ausente/null/1..10000; audits solo en cambio real: mcp.tool.enabled/disabled, rate_limit_set, expose_to_ai_set); gates {admin, mcp.connections.write} | `TestMcpAdminRoutes` (fail-closed, discovery en create, read-only marking, tri-estado, audits) + `TestReadinessMcpToolApprovalGate` (write-side default detrás del gate de approval; con ancestro approval calla) + dry-run split en `TestMcpToolNodeThroughRun` (read-only EJECUTA en validación, write-side SALTA) | El registry sweep cubre los gates nuevos automáticamente; el catálogo de audit ya traía las 4 acciones mcp.tool.* |
| T-123 | Catálogo único `internal/ai/failcat`: 9 casos wire (auth 401/403, rate 429, overloaded 529/500, invalid_request 400, garbage 200→network, timeout, endpoint muerto) + 5 réplicas hostiles (sin JSON, fenced, truncado reparable, BOM+ZWSP, prosa+JSON) con `Handler()` y `SuccessEnvelope()` compartidos | CUATRO suites lo consumen: cliente ai (clasificación del chokepoint), freejson (repair-or-fail por réplica), `/ai/generate-workflow` (200 + mode fallback + clase aiError + template intacto), nodo ai por run real (el run TRIUNFA con `{mode:fallback, aiError}`) | `garbage_200` clasifica `network` — el SDK lo reporta como fallo de decode a nivel transporte (un proxy roto), que es lo que realmente es; timeout/network quedan en la suite del cliente (presupuestos sub-segundo que el piso del catálogo org no permite en superficies) |
| T-124 | Corrida formal del harness Node (`scripts/run-evals.mjs` intacto, sin fork) contra el binario Go en :4699 — **3 passed, 0 not-passing, 27 skipped, exit 0**; gate `summarizeAi`/`compareToBaseline` sin tocar | Deterministas 100% (3/3 con ids de template clavados); los 27 `requiresMode:"ai"` saltan limpiamente porque el fallback del Go sin key NO lleva `aiError` (el contrato de skip de evals) | Divergencia aceptada explícitamente: la tasa ai-mode no se mide a $0 — una corrida dorada gasta créditos y es invocación del usuario (decisión vigente de la ola 3); queda en los diferidos del REPORT-W4 |
| T-125 | `POST /validate` (+ `/v1/validate`) con la forma Node `{valid, issues}` directa de `domain.Validate` — cuerpo plano o sobre `{workflow}`, SIN el carve-out del pilot (a diferencia de save, /validate reporta la lista completa incl. `node_type_unsupported_pilot`); `PlannerTools` gana el `jsonSchema` planner-only derivado de la tabla de campos — `Catalog()` (GET /tools) NUNCA lo incluye | `TestValidateRouteAndPlannerProjection` (paridad de códigos: `empty_workflow`, `edge_invalid_to`, `input_default_type_mismatch`, `node_type_unsupported_pilot`; /tools sin `jsonSchema`, planner con él); gates {editor, workflows.write} cubiertos por el sweep | `code` NO está en el vocabulario de plataforma del pilot → `unsupported_node_type`; el ejemplar pilot-unsupported correcto es `subworkflow`; inputs usan la gramática recursiva `{type:object, properties:{...}}` |
| T-126 | `internal/resumetoken` (HMAC-SHA256 `v1.<payload>.<firma>`, binding org/run/node/purpose, `issuedAt`+`expiresAt` FIRMADOS, TTL 300..604800, legado v1 sin expiresAt → frontera exacta de 7 días, error uniforme, secreto dedicado con fallback dev y rechazo en producción) + executor `human_form` (schema no vacío o `human_form_schema_required`; proyección de fields) + firma EN el engine (`MarkNodeWaiting`, TTL de `runs.humanFormResumeTtlSeconds`) + `ResumeRunWithInput` (token requerido + verificado, input validado contra el subset del schema, input = output del nodo, CAS solo still-waiting) + `/resume` extendido con las formas Node (400 token_required / 400 input_validation_failed / 403 invalid_resume_token / 409 conflict) | Matriz unitaria de tokens (expirado, purpose cruzado, run/org ajenos, tamper, cotas TTL, legado dentro/fuera de 7d, rotación de secreto, producción sin secreto) + `TestHumanFormResumeLoop` (pausa con token firmado, matriz por wire, CARRERA de replay: exactamente un ganador, downstream UNA vez, output = input validado) | El executor no ve el secreto ni la política — el engine firma al persistir el checkpoint; `ai` dejó de ser el ejemplar pilot-unsupported en domain_test (drift arreglado con `subworkflow`) |
| T-127 | Dos smokes nuevos en `go-pilot-smoke.spec.ts` contra el web REAL: (a) AI Studio — copilot real → `Draft flow` a $0 (fallback approval-gate con banner "Starter flow loaded locally") → Validate → Save → Run → fila del run en Activity → Approve → succeeded; (b) human form — canvas `Collect form` → Run → fila del run → `Fill form` → dialog schema-driven → Submit → run continúa; ambos con cero pageerrors. Runner gana pre-limpieza de los 5 ids fijos de template (colisión cross-org real compartida con Node) | `node go/conformance/run-web-smoke.mjs` → 4/4 verdes (2 corridas consecutivas) | BUG DE PARIDAD encontrado y arreglado: el `/start` de Go exigía el sobre `{workflow}` y el web manda el workflow PLANO (Node acepta ambos) — startCore ahora acepta ambas formas; segunda causa de flakes: un binario huérfano de pruebas compartiendo la DB reclamaba jobs con otro env (matado; lección: `kill %1` no cruza llamadas de shell) |
| T-128 | REPORT-W4.md: tabla de paridad de evals (3/3 deterministas, 27 skip limpio, gate exit 0), costo real $0 (2.046 filas llm.completion del simulador, 195.704 tokens contados, cero créditos), 5 divergencias AI vivas documentadas, recomendación ola 5 (contrato de recovery primero, reusar replay_mode/failcat, mapear contra lo ya portado, presupuestar corrida dorada) | Informe entregado; suite completa 24 paquetes verdes -race, lint 0, smoke 4/4 | Cierra la ola 4: 30/30 done, 130/130 acumulados |
| T-129 | `internal/domain/recoverycase.go` (escalera cerrada de 12 estados portada verbatim de recovery-case.ts, 4 terminales, vocabulario de evidencia cerrado, validación de receipt: actor user/agent exige id, evidencia 1..100, sha256 hex64, reason ≤1000) + `internal/engine/recoverycases.go` (`StableSemanticID` sem/sct, `CreateRecoveryCase` idempotente por (org,run,detector), `TransitionRecoveryCase`: validación → CAS `state=from` → receipt con id determinista en UNA tx; receipt rechazado por el índice único `(case_id,to_state)` → rollback del estado — avanzar sin receipt es imposible) | Escalera portada de recovery-case.test.ts + integración: salto ilegal escribe NADA, CAS obsoleto sin receipt, carrera de 2 operadores → exactamente un ganador y un receipt, terminal estampa `resolved_at` y no tiene salidas, receipts append-only en orden | Las tablas + índices únicos YA estaban en el baseline goose (patrón "ya estaba" x4); la postura single-visit del índice `(case_id,to_state)` prohíbe re-entrar a un estado aunque el mapa legal permita el rebote validating→candidates_ready — herencia deliberada de la referencia (onConflictDoNothing) |
| T-130 | `internal/domain/recoverycontract.go` (vocabularios cerrados: niveles 0-4, 6 kinds de evidencia, efectos/idempotencia/receipts, 6 clases de repair; validación V1/V2 completa portada — V1 JAMÁS activa semántica (regla dura), autonomía por fallo/detector ≤ techo del workflow, evidencia base retenida, un efecto por nodo, implicaciones del nivel de evidencia, bundle completo de Level 4 con narrowAutonomy + efectos idempotentes, breaker union false\|2..100\|{consecutiveFailures}) + `Workflow.Recovery` validado EN Parse (issues `invalid_contract` con path `recovery.contract` — paridad Node) + `internal/recovery/semanticoutcomes.go` (evaluador determinista puro: expresión por la MISMA gramática de aristas con overlay del output completado, schema por el subset compartido, error de expresión = violación con detalles fail-safe, replay de fixtures con el evaluador exacto) | Port de recovery-contract.test.ts (V1-semántica, techos, evidencia, Level 4, uniques, fixtures 2..50) + breaker union + Parse valida + evaluador (quarantine domina observe same-source, V1 evalúa CERO, contexto cross-node, nodo ajeno fuera) | Paquete nuevo `internal/recovery` (grammar+domain sin ciclos); `supportsAutonomousRecovery` = provider_simulated/live_canary |
| T-131 | `internal/domain/recoveryautonomy.go` — proyección PURA del perfil: escalera de 5 capacidades (observe/recommend/validate/apply_with_approval/autonomous_apply → pisos 0-4), `ResolveRecoveryAutonomyProfile` (override por fallo gana — solo puede BAJAR, el validador del contrato ya vetó subir; default del workflow si no hay; contrato/política ausente → `unavailable` FAIL-CLOSED con razón) y `CombineRecoveryAutonomyProfiles` (cohortes same-source: el detector MÁS estricto gobierna vía min; un miembro unavailable envenena el agregado cerrado; ids deduplicados; fuente `strictest_failure`) | Port de recovery-autonomy.test.ts (default, override menor con la escalera de factores exacta, fail-closed, combinación estricta) + técnico override/default + V1 sin política semántica pero técnica resuelta + agregado envenenado + vacío cerrado | El módulo NO otorga autoridad de mutación — es proyección explicable; cierra la aceptación pendiente de T-130 (mismo-source → estricto con detectores en conflicto) |
| T-132 | `internal/domain/recoverydag.go` (reglas fail-closed de save: dominancia — ninguna raíz alcanza el efecto sin pasar por la fuente quarantine; write-side reales deben declararse en effects; fuentes deferred-completion (approval/human_form/subworkflow/wait_until/webhook) y routers-quarantine rechazados; calificación de fixtures vía `ValidateWithSemanticFixtures` con el evaluador REAL inyectado en las 5 superficies) + intercepción runtime en `CompleteNode` (evaluación pre-tx sobre el snapshot con overlay del output; observe crea caso `detected` sin pausar; quarantine crea caso `contained` + receipt detected→contained + evento `recovery.semantic_violation` + run→`waiting` EN la misma tx — el downstream jamás se agenda; `outcome_status`/`semantic_violation_count` proyectados; sandbox `replayMode=validation` excluido) | `TestSemanticContractDAGRules` (dominancia con bypass, no-declarado, deferred, router, fixtures mismatch/missing, expresión rota) + `TestSemanticOutcomeInterception` (observe completa, quarantine pausa con calc=succeeded/after=pending + receipt + evento, output limpio cero casos, sandbox cero casos) | `runs.outcome_status`+`semantic_violation_count` YA estaban en el baseline (patrón x5); el replay de fixtures viaja como costura inyectada (domain sigue sin depender de grammar) |
| T-133 | `Input.DryRun` general (dispatch lo computa UNA vez desde `runs.replay_mode` y lo reparte; las costuras AI/MCP/memoria ya lo tenían): el nodo `tool` salta TODO tool write-side del registry (`registry.IsWriteSide`), el nodo `http` salta métodos no-GET/HEAD/OPTIONS — ambos con el sobre `{skipped:true, reason:validation_dry_run}`; `runs.validation_evidence_level='static'` estampado al NACER el run de validación (InsertRun); proyección del run expone las columnas reales (`outcomeStatus`/`semanticViolationCount`/`validationEvidenceLevel`) | `TestToolNodeDryRunWriteSkip` (tool write-side de prueba NUNCA dispara + read-side sí ejecuta) + `TestSandboxReplayGate` (validación: GET dispara, POST salta con el skip persistido, evidencia static de nacimiento; producción con el MISMO workflow dispara el write — el gate es el replay mode, no el workflow) | Los replays sandbox ya quedaron excluidos de casos semánticos (T-132) y de la racha del breaker/métricas verified por diseño (T-136/T-138 leen `replay_mode`); email.send no existe aún en el registry (ola 6) — el skip genérico se probó con un tool de prueba registrado |
| T-134 | `POST /dlq/validate-fix` (+ /v1; gates {editor, recovery.write}; bucket rate "ai"): valida el fix propuesto con el MISMO gate de gramática que la salida de /ai/patch-workflow (Parse + ValidateWithSemanticFixtures; solo `node_type_unsupported_pilot` no bloquea), exige el nodo fallido presente, y siembra un run de VALIDACIÓN fresco vía `engine.ReplayDeadLetterAsValidation` (workflow sugerido + input RESUELTO del run original + `replayMode=validation` + linaje trace-only `parentLinkKind=replay` + evidencia static de nacimiento); `StartInput` ganó ParentRunID/NodeID/LinkKind (sustrato de T-135); postura pilot: `provider_simulation` → 409 unavailable, playbookId → 409 match_changed (hasta T-139); audit `recovery.validation_started` | `TestValidateFixSandboxGate` (7 rechazos pre-run + fix sano: el upstream de escritura NO recibe hits (delta 0), linaje replay/parent/evidencia static verificados en el run, input original sembrado, audit) | El run original que sembró el DLQ ya había pegado 1 write — el assert correcto es el DELTA |
| T-135 | DECISIÓN al leer la fuente: el replay de PRODUCCIÓN de Node TAMBIÉN es revive-in-place (claim + republicación en el MISMO run, attempt re-armado a 1) — el run de continuación con `parentLinkKind=replay` es SOLO el sandbox de validación. Cerrado F05: `RedriveFailedRunNode` re-arma `attempts=1`; divergencia eliminada de la tabla del runner y paridad verde contra el golden SIN excepción. Rama exact-identity `{runId, nodeId}` en `/dlq/replay` (la forma que postea el panel del run — `RedriveRunNode`, 403 cross-org, 409 conflicto). Validación con forma de CONTINUACIÓN (paridad del adapter): ancestros COPIAN contexto terminal del run original, solo el nodo fallido arranca queued attempt 1, descendientes pending (cascada ordinaria), resto skipped `outside_validation_path`; evento `run.started.validation` | Paridad F01-F17 verde SIN la excepción F05; `TestValidateFixContinuationShape` (ancestro copiado visible en templates del descendiente, evento, exact-identity re-arma a 1); redrive test actualizado; smoke web 4/4 | El linaje `parentLinkKind` es trace-only: profundidad/terminal-delivery siguen solo aristas ejecutables |
| T-136 | Pipeline exacto portado de recordRecoveryImpactTx: el redrive estampa el claim (`recovery_dead_letter_id` + token fresco por replay — generation-bound, un claim viejo no acredita otra ejecución) → `CompleteNode` acredita EN la misma tx de completación: identidad exacta (id+run+node) verificada, `dead_letters` converge open→replayed, `recovery_impact_events` idempotente (unique dead_letter_id, ON CONFLICT DO NOTHING), rollup O(1) por upsert de PK (`total+=1`, `downtime+=`, LEAST/GREATEST) SOLO para producción (replay_mode null); la iniciación jamás acredita | `TestRecoveryImpactPipeline` (redrive fallido acredita 0; éxito terminal acredita EXACTAMENTE 1 + rollup + dead letter replayed; doble crédito imposible por el unique; sandbox win registra el hecho pero JAMÁS infla el rollup) + EXPLAIN del upsert: Conflict Arbiter = PK, sin scans — O(1) verificado por plan | La rama exact-identity (runId+nodeId, sin dead letter) no estampa claim — como la referencia, no acredita impacto |
| T-137 | El redrive ABRE el incidente (`recovery_items` idempotente por unique (org, dead_letter), severidad p3 + SLA 24h + firma) y el cierre viaja SOLO con el éxito terminal: CAS open→resolved (`sandbox_replay_succeeded`, `first_action_at` set-once desde `replay_claimed_at`) + audit `recovery.item.resolved` EN la misma tx del impacto — la aceptación de enqueue jamás se disfraza de recovery. Atribución de playbook: claim con playbook+validationRun → audit `recovery.playbook.applied` (el receipt durable llega con T-139). RECONCILIACIÓN T-055: `QueryVerifiedRecoveryStats` ahora lee `recovery_impact_events` (el hecho durable generation-bound) con `replay_mode IS NULL` — imposible de inflar por iniciación | `TestRecoveryItemAttribution` (iniciación abre y NO resuelve; replay fallido mantiene open; éxito terminal resuelve + audita + first_action_at; métrica sobre hechos durables con muestra 1 y p50 > 0) | El audit in-tx usa `InsertAuditLogRow` (query sqlc nueva — audit.Write es pool-level y no cruza la tx) |
| T-138 | Decisión PURA en `internal/recovery/circuitbreaker.go` (kill switch env default ON, threshold: workflow knob false/2..100 → org `runs.circuitBreakerThreshold` → 5; solo un workflow ACTIVE con racha ≥ umbral dispara) + trip en `FailNode` post-tx (best-effort: nunca rompe el camino DLQ; CAS `active→paused_circuit_breaker` + audit `workflow.circuit_breaker.tripped` en una tx — exactamente un anuncio bajo carrera; sandbox excluido vía replay_mode ANTES de evaluar y en la query de racha) + gate en `/start` (409 con `workflow_circuit_breaker_paused` vs `upstream_degraded` — el código nombra la causa) + `POST /workflows/{id}/resume` DELIBERADAMENTE manual (CAS solo desde paused_circuit_breaker; otra pausa → 409 con status; backfill oldest-first de buffered con claims `backfill_claim_token` + página 50 + el CAS de trigger-start ampliado a `received\|buffered` — cierra la divergencia de T-040) | `TestCircuitBreakerLoop` (racha de 3 → UNA pausa+audit; /start 409; 3 triggers 202-buffered; resume 404/flip+audit; backfill drena 3 en orden evt-0..evt-2; resume repetido reporta 0 limpio) | El input del run backfilled desenvuelve el anchor `{event:{...}}` para calzar byte-igual con el shape del ingest ordinario; el drop de ticks de cron queda como seam (scheduler = ola 6) |
| T-139 | `internal/engine/playbooks.go` (draft idempotente por source-version + versión monotónica por (org,firma) con retry acotado; activate en tx: retira el active previo del match exacto + CAS draft→active — el índice parcial único del baseline convierte la doble activación en 409; retire idempotente; `VerifyPlaybookReplayClaim` porta la cadena completa: playbook ACTIVE + match exacto (firma vía `signature.NormalizeJSON` del error del DLQ) + run de validación succeeded/validation/parent-correcto/portando-el-playbook + workflow byte-idéntico; auto-retire con `regressions++` en el flip terminal de un sandbox FALLIDO — misma tx) + rutas draft/match/activate/retire + validate-fix con matching real + `/dlq/replay` con claim verificado (400 mitad / 422 evidencia inválida) + recibo durable `RecordPlaybookApplied` (set-once por validation run) en la tx del impacto | `TestRecoveryPlaybookLoop` (sandbox fresco → draft → idempotencia → activate → match → claim 400/422 → sandbox CON playbook → replay verificado → uses=1 + audit → regresión auto-retira con marca) | Cierra el pendiente de T-134 (playbook 409 incondicional) y el recibo diferido de T-137 |
| T-140 | `internal/recovery/drilloutcome.go` (composición PURA portada verbatim: capped→measurement_incomplete domina todo, recovered domina accepted, open→awaiting, claim sin resolución→in_progress; ventana de recurrencia de 7 días monitoring→clear/recurred; elapsed acotado; evidencia terminal_impact/explicit_resolution) + el CTE de hechos del chain como SQL crudo en la ruta (sqlc no tipa el chain materializado — precedente del sustrato de memoria) + `GET /recovery/drills/outcome?deadLetterId=` y `GET /recovery/drills/dossier` (50 raíces recientes con actividad de replay, summary por status; el JSON ES el export) | Unit del builder (precedencias + ventanas) + integración sobre un chain REAL recuperado (2 intentos, terminal_impact, monitoring, dossier agrega, 404) | El chain se mide desde la RAÍZ: la cadena same-run/node completa con cap 100+flag |
| T-141 | `internal/recovery/calibration.go` (fit puro portado: buckets de 10 puntos, mínimos cuadrados PONDERADOS, piso de 20 muestras, guard de monotonía — slope ≤ 0 REHÚSA la curva para no invertir el orden de dos sugerencias; `ApplyCalibration` monotónica y clamped [0,100], identidad sin curva) + `POST /recovery/feedback` (labels cerrados, rawConfidence 0..100, audit) + `RunCalibrationSweep` del engine (orgs con feedback en 30d, toggle `ai.confidenceCalibrationEnabled`, cap 5000 muestras/approach y 500 orgs, upsert por (org, approach), ABSTINENTE si el fit rehúsa) + `GET /recovery/calibrations` | Unit del fit (piso, positivo, invertido rehusado, bucket único degenerado, clamps) + loop por wire (24 decisiones → sweep → una curva slope>0 → toggle off abstiene) | La aplicación de la curva EN el patch dialog sigue diferida (decisión de usuario de la ola 4) — la maquinaria completa queda lista; el cableado del sweep a cron llega con el scheduler (ola 6) |
| T-142 | `internal/domain/recoveryitem.go` (escalera cerrada open→acknowledged→in_progress↔waiting_external→resolved→reopened con la tabla ALLOWED_PRE_STATES verbatim — el CAS es el predicado; razones de resolución cerradas con `sandbox_replay_succeeded` VETADA a mano; severidades + escalamiento hacia p1; comments 4000 chars / 200 por item) + rutas GET /recovery/items y POST /recovery/items/{id}/{action} (acknowledge con owner/severity, in_progress, waiting_external, resolve, reopen, assign, escalate — todos auditados con first_action_at set-once) + handoff durable (`recovery_item_handoffs` upsert por (org,item,destino), dispatch_count++, outcome `delivery_failed`+`dispatcher_unavailable` HONESTO — la entrega llega con integraciones ola 6) | `TestRecoveryItemOwnership` (escalera completa, doble-click 409, escalate a p1, razón sandbox rechazada, resolve/reopen, handoff idempotente con contador) | El incidente lo abre el redrive (T-137); el drawer opera sobre ese sustrato |
| T-143 | `internal/httpapi/recoveryqueue.go` — GET /dlq/queue con sobre {items, nextCursor, hasMore}: join dead_letters + overlay recovery_items + nombre de workflow, filtros server-side ANTES del tope (status/severity/owner con `me`→userId/search ILIKE escapado ≤100/day UTC), cuatro sorts de orden total (newest/oldest/severity/sla con NULLS LAST) y keyset propio por sort — el cursor opaco (base64url sin firma, el org scope se re-aplica siempre) se decodifica contra el sort EFECTIVO (sort distinto → página 1); over-fetch tamaño+1 (default 50, tope 100) para un hasMore honesto; el /dlq desnudo (sin id) pasa a servir el MISMO join como array (preview del Home) — cierra el gap de T-064 | `TestRecoveryQueueReadModel` (orden por sort, páginas keyset severity 1-a-1, cursor cruzado ignorado, owner=me, filtros, day + day malformado, 400s de enum, array desnudo, aislamiento multi-tenant) | SQL crudo con fragmentos de conjunto cerrado + valores SIEMPRE parametrizados (sqlc no tipa el keyset por sort; precedente del CTE de drills) |
| T-144 | `internal/httpapi/bulkrecovery.go` — GET /dlq/cluster-members (ids abiertos cuya firma normalizada coincide con el cluster reclamado, scan 500/ventana 1..90d, tope 100, {deadLetterIds,total,capped,windowDays}); POST /dlq/cluster-apply (hasta 100 filas en serie, cada una RE-validada contra la firma en el server — lista rancia rechazada por fila; fix opcional validado UNA vez por la gramática y aplicado solo a miembros del MISMO workflow cuyo nodo fallido sobrevive el patch, con reclamo de playbook verificable solo en el representante; sobre parcial + downtimeEndedMs 0 honesto); POST /dlq/bulk-replay (lote mixto sin firma, solo filas open, claim CAS de un solo uso); POST /dlq/resolve + /dlq/bulk-resolve (aceptar la pérdida: el item vinculado cierra `accepted_loss` — un dismiss nunca es una victoria de replay). Motor: `RedriveDeadLetterWithOptions` — el fix reemplaza runs.input_json.workflow EN la misma transacción del redrive (el worker ejecuta desde ese snapshot, así el nodo revivido corre el patch y el run registra la configuración que usó de verdad) + override de firma de cluster para el item | `TestBulkRecoverySurfaces` (miembros por firma, validaciones de lote 400, apply con fix que SANA los runs revividos — succeeded post-swap, miembro rancio rechazado, re-apply reporta already-replayed, bulk-replay parcial + reclamo CAS agotado, resolve cierra item accepted_loss, bulk-resolve parcial) | El status del dead letter converge open→replayed en el impacto terminal (postura T-136/T-137), no en el enqueue como la referencia |
| T-145 | `internal/httpapi/recoveryhome.go` — GET /recovery/home con secciones que se resuelven INDEPENDIENTES ({status:ok,value}|{status:unavailable}): scope=impact (ledger del rollup O(1), victorias del operador 30d sobre impact events reales, overview de cola con counts + oldestOpen) y scope=full (+ metrics verifiedRecovery, heatmap 90d por día con mediana de downtime, casos semánticos abiertos ≤50, validación = resumen del dossier de drills, y clusters con `recurredAfterRecovery` REAL — `QueryRecurredClusterSignatures`: recuperado con impacto terminal en la ventana Y re-ocurrido dentro de sus 7 días de monitoring, replays excluidos). La bandera también viaja en el /dlq/clusters enfocado (mismo value compartido — no derivan). Cierres de consistencia: el redrive ahora estampa `recovery_requested_by` (las victorias del operador dejan de ser siempre 0) y la firma del item usa el normalizador de clusters vía `DeadLetterSignature` (antes era el mensaje crudo — la recurrencia por item no calzaba con las firmas de cluster) | `TestRecoveryHomeReadModel` (scope impact sin secciones full, ledger≥1, wins atribuidas al operador, oldestOpen, scope full con recurrencia true en el cluster recuperado+reocurrido, heatmap del día con failures+recovered, metrics con muestra, dossier) | Secciones nuevas queries sqlc: QueryRecoveryHeatmap, QueryOperatorRecoveryCount, QueryRecurredClusterSignatures |
| T-146 | `internal/engine/alerts.go` — `DispatchAlert(org, trigger, payload)`: catálogo cerrado de 11 triggers, políticas habilitadas por (org,trigger), filtros por parámetros (workflowIds allowlist, patrón de firma para dlq.entry_created, severities para recovery_item.*), cooldown dedupe por (policy, dedupeKey) y entrega webhook por el MISMO chokepoint HTTP del nodo `http` (SSRF + pin + tope heredados); slack/email/github registran `dispatcher_unavailable` honesto hasta la ola de integraciones; cada disparo escribe `alert_dispatches` con resultados por canal; el productor JAMÁS se rompe (post-commit + swallow). Productores reales: dlq.entry_created (afterTerminalFailure, dedupe por workflow+nodo), recovery_item.created (redrive post-commit), workflow.circuit_breaker_tripped (trip post-commit — el CAS ya dedupea anunciantes). `internal/httpapi/alerts.go`: CRUD de políticas (admin+alerts.write, 422 con lista estructurada, 409 por nombre único, update parcial COALESCE, delete) + GET /alerts/recent (viewer+alerts.read, tope 200) | `TestAlertingPipeline` (422/409, webhook entrega REAL + slack honesto en el mismo dispatch, cooldown suprime mismo dedupeKey, workflow distinto dispara, filtro de severities en el productor de items, disable apaga, delete + 404) | Cierre chico: `deadLetterSignatureFromParts` comparte el normalizador con los productores |
| T-147 | `internal/recovery/runexplain.go` (builder PURO portado: summary, causa raíz por la taxonomía de firmas compartida con suggestedOwner→next action, nodo fallido con resumen de error, timeline tope 50 conservando la COLA, suggested fix del último audit `ai.workflow.patch_suggested`; toda cadena libre re-pasa `ScrubSecretShapes` además de la redacción de escritura) + `internal/httpapi/reports.go`: GET /reports/run-explain?runId=&format=markdown|json (viewer+reports.read, descarga con Content-Disposition, 404 uniforme cross-org, audit `report.run_explain.exported`) y POST /recovery/items/{id}/evidence?format= (editor+recovery.read — patrón literal gana al {action} wildcard del mux): el paquete de evidencia de UN incidente — incidente + dead letter con firma + run-explain del run original + el replay de validación más fresco + audit trail acotado a (run, dlq, item), audit `report.evidence.exported` | `TestRunExplainAndEvidenceExports` (markdown con secciones + disposition, JSON con causa raíz/nodo/timeline/next action, 400s de contrato, 404 cross-org, bundle de evidencia con los 5 bloques + su propio audit) | Delivery Slack/GitHub/webhook del reporte = ola 6 integraciones (diferido) |
| T-148 | /recovery/metrics gana dos métricas: `timeToFirstAction` (avg+p95+muestra desde el set-once `first_action_at` — lo estampa la PRIMERA transición del operador o el impacto terminal, nunca se mueve después; los tenants sin item contribuyen por el claim de replay pre-enqueue, con exclusión de doble muestreo) y `recurrence` (resueltos/reocurridos/stayedFixedRate% sobre la ventana FIJA de 7 días anclada al evento de impacto INMUTABLE — misma CTE que la bandera de clusters de T-145, sandbox excluido) | `TestFirstActionAndRecurrenceMetrics` (item sin acción arranca sin estampa, acknowledge estampa, in_progress NO la mueve — set-once probado por psql; métricas con muestra ≥2, recurrencia con resolved+recurred y rate 0..100) | Ambas queries sqlc (`QueryTimeToFirstAction`, `QueryRecoveryRecurrence`) portan las CTEs de referencia incl. la pierna de `recovery_item_children` (tabla en baseline, sin escritores aún) |
| T-149 | `internal/engine/rollouts.go` — el sustrato de despliegues baseline/canary (tablas ya en baseline): `CreateWorkflowRollout` con la escalera completa dentro de una transacción con lock del workflow padre (bounds 1..50/5..100/1..100, canary estrictamente más nuevo Y ÚLTIMO guardado, contratos de trigger externos byte-idénticos vía stableJSON, un solo activo por workflow — el índice único parcial convierte la carrera en active_exists, y el gate V2 exige receipt de calificación passed por par exacto), `WorkflowRolloutBucket` (sha256 del par JSON, primer uint32 BE % 100 — mismo bucket que la referencia), `ResolveWorkflowRolloutAssignment` (solo mientras el canary siga siendo el último; active→bucket, promoted→canary, terminado→baseline) y `FinishWorkflowRolloutCAS`. `/v1/start` resuelve la asignación cuando el doc trae id de workflow: el snapshot del variant REEMPLAZA el doc del request y el run captura la elección CONGELADA — `runs.workflow_rollout_id`+`variant` + los mismos campos en el payload de run.started. Rutas GET/POST /workflows/{id}/rollout + decisión promote/rollback (admin+workflows.write) | `TestWorkflowRolloutAssignment` (bounds 422, canary_not_latest, 409 doble activo, 20 starts al 50% capturan rollout+variant+versión EXACTA del variant y el evento lleva la asignación, promote→todo canary, segunda decisión 409) | T-150 (locking de versión), T-151 (receipts), T-152 (outcomes/auto-rollback), T-153/154 (canary nunca en validación/pins + ingest) siguen |
| T-150 | Version-write locking: `POST /workflows/save` y `POST /workflows/rollback` rechazan 409 `workflow_rollout_active` mientras haya rollout activo (acuñar una versión más nueva desprendería al canary de "latest" en silencio — el operador termina el rollout primero); el DELETE del workflow tombstonea Y cancela el despliegue activo (`cancelled` / `workflow_deleted`) en la MISMA transacción. La compatibilidad estricta de triggers externos ya vive en el create (T-149): contratos byte-idénticos (id+type+config de schedule/email_received/file_dropped/mcp_server_event vía stableJSON) — probada aquí con el par incompatible/compatible | `TestRolloutVersionWriteLocking` (canary con schedule nuevo → 422 incompatible_triggers; contratos idénticos → create OK; save/rollback → 409 bajo rollout; delete cancela con razón, verificado por psql) | — |
| T-151 | `internal/recovery/qualification.go` — `QualifyRecoveryCandidate` portado: el baseline es dueño del dataset de regresión; el candidato re-ejecuta ese snapshot INMUTABLE más sus propias fixtures por el MISMO evaluador del runtime (ningún nodo corre, ningún provider se llama, ningún juez LLM otorga autoridad); V1→V2 = bootstrap, baseline V2 = compare con regresiones (`detector_uncovered`/`expected_mismatch`) y dataset digest sha256 sobre el render estable; el receipt durable (`ToReceiptSummary`) recorta los internals de violación. Rutas GET/POST /workflows/{id}/rollout/qualification (upsert por índice único exacto de 6 columnas, audit `workflow.recovery_qualification.recorded`); el gate del create (T-149) exige status=passed para el par EXACTO | `TestRolloutQualificationReceipts` (required sin receipt → create 409; bootstrap passed desbloquea el create; regresión de cobertura en compare → failed con regressionCount y el gate SIGUE cerrado; par sin contratos → not required) | Receipt failed NO satisface el gate — solo passed |
| T-152 | `internal/engine/rolloutoutcomes.go` — `RecordWorkflowRolloutOutcome`: UNA transacción por outcome terminal de producción — receipt idempotente (PK run_id, ON CONFLICT DO NOTHING → duplicate), re-validación completa (rollout ACTIVO, variante↔versión exacta del run congelado, replay excluido, cancelled no cuenta en tasas), contadores agregados CAS y el auto-rollback cuando el canary alcanza la muestra mínima por debajo de la tasa mínima — CAS a rolled_back + audit `workflow.rollout.auto_rolled_back` con la evidencia observada EN el mismo commit (exactamente una vez). Evidencia congelada: un terminal que llega después del finish se IGNORA. Hooks post-commit en ambos caminos terminales (CompleteNode + afterTerminalFailure) + `RepairWorkflowRolloutOutcomes` acotado (500) para ventanas de crash, corrido como read-repair en el GET del rollout (cron = ola 6) | `TestRolloutAutoRollback` (canary roto alcanza 5 fallos → rolled_back canary_success_rate_breach + audit exactamente una vez, receipts≥contadores, evidencia congelada tras el finish, ventana de crash simulada → el repair re-conduce receipt+contadores) | — |
| T-153 | El contrato "canary solo para tráfico de producción nuevo" queda garantizado POR CONSTRUCCIÓN y probado por wire: la asignación se resuelve en UN solo punto (el /start de producción); el run de validación (validate-fix) nace con replay_mode=validation y campos de rollout NULL — jamás consume canary ni produce receipt de outcome; el redrive revive en sitio conservando la asignación CONGELADA original (mismo rollout id + variant) y su terminal post-replay no puede doble-contar (receipt PK run_id → duplicate, contadores intactos). El nodo subworkflow sigue fuera del alcance del piloto (tipo no ejecutable), así que el pin explícito de subworkflow no tiene superficie que guardar — documentado | `TestValidationAndReplayNeverConsumeCanary` (hijo de validación: mode=validation, rollout NULL, 0 receipts; revival: asignación congelada intacta, receipts=1, canary_succeeded sigue 0 tras el éxito del revival) | Pins de subworkflow quedan para cuando el ejecutor de subworkflow entre al piloto |
| T-154 | El ingest de webhooks resuelve la asignación de rollout EN LA ACEPTACIÓN (assignment key = id durable del evento — determinista y re-derivable), la captura en `trigger_events.workflow_rollout_id/variant` ANTES de que exista el run, y exige que el nodo trigger exista en el snapshot de la versión ASIGNADA — si el variant asignado no lo tiene (webhook_received queda fuera del contrato de triggers externos justamente por esto) responde 409 `trigger_no_matching_node` en vez de redirigir el evento a una versión que no puede servirlo. El run del ingest ejecuta el snapshot asignado con los mismos campos congelados. El backfill del breaker (T-138) ahora honra la asignación CAPTURADA del evento buffered: ejecuta el snapshot del variant capturado, nunca la versión que el rollout mutable señale hoy | `TestTriggerIngestRolloutAssignment` (20 eventos al 50%: evento y run concuerdan en rollout/variant/versión exacta, ambos variants aparecen) + `TestTriggerIngestAssignedVersionMissingNode` (baseline sin nodo → 409 con código; canary con nodo → 200; ambos brazos al 50%) | Dedupe: una entrega repetida adopta el evento persistido con su asignación original — jamás re-asigna |
| T-155 | Quinto smoke en `apps/web/e2e/go-pilot-smoke.spec.ts` (`recovery queue, drawer, and bulk replay against Go`): la ruta experta oculta (activeTab=recover) monta la cola real contra el /dlq/queue de Go — filtro Show=Open por defecto (la fila replayed oculta hasta ampliar a All), búsqueda server-side que estrecha a una fila por runId, drawer del incidente abierto por el badge real con acknowledge verificado por wire (escalera CAS), y bulk replay por el multi-select real (toggle → checkboxes → confirm) sanando dos runs contra el upstream curable del propio spec. 5/5 smokes verdes vía `node go/conformance/run-web-smoke.mjs` | Corrida completa: boot + operador + AI studio + human form + cola experta | El diálogo web de cluster-apply (RecoveryDialog en modo cluster tras Suggest fix) queda como gap conocido del smoke — la superficie cluster-apply está probada por wire en T-144; el diálogo AI ya tiene su smoke de ola 4 |
| T-156 | `internal/recovery/failmatrix/failmatrix.go` — el catálogo ÚNICO de fixtures hostiles de recovery (regla del proyecto, mismo patrón que el failcat de AI): 28 casos en 5 superficies — replay (6: dlq inexistente, claim quemado, medio-claim de playbook, claim inverificable, identidad exacta ajena, campos requeridos), cluster-apply (7: firma faltante, ids requeridos/tope/vacíos, firma que no calza → sobre parcial, fix con schema roto, playbook sin representante), validate-fix (5: dlq inexistente, workflow requerido, effect mode desconocido, provider_simulation no disponible, schema roto), items (7: item fantasma, acción desconocida, CAS perdido, razón sandbox vetada, severidad inválida, assign sin owner, destino de handoff desconocido) y queue (3: enums de filtro). Cada caso fija status + código de error exactos (o el sobre parcial); stdlib-only para que cualquier suite o el seeder lo importe sin ciclos | `TestRecoveryFailureMatrix` — 28/28 subtests verdes iterando el catálogo contra el wire real con entorno sembrado (dlq abierto + claim quemado + item acknowledged + firma real de cluster) | Un modo de fallo nuevo = UNA entrada en el catálogo y aterriza en todas las superficies |
| T-157 | Ocho fixtures nuevas F18–F25 en `conformance/fixtures.json` con verbos nuevos en AMBOS drivers (gen-goldens.mjs + harness Go): F18 validación salta write-sides (validateFix — el run de producción falla, el sandbox del MISMO doc sucede sin sanar el upstream), F19 breaker pausa tras racha 2 (startExpectPaused 409), F20 evento buffered → heal → resume → backfill (ingestExpectBuffered/resumeWorkflow/adoptNewestRun), F21 observe semántico no pausa, F22 quarantine parquea el run en waiting, F23 rollout promovido sirve el snapshot canary (el nodo b2 de v2 aparece en la proyección), F24 rollback sirve baseline (b1), F25 cluster-apply con fix SANA el run revivido (attempt 1). Goldens capturados SOLO vía el stack de referencia aislado (`run-reference-stack.mjs` — dos correcciones de contrato desde el propio stack: `effects: []` y `technical.stalledNode` requeridos por el schema Zod de referencia). Paridad Go 26/26 al PRIMER intento, ×3 corridas idénticas, tabla de divergencias aceptadas sigue VACÍA | `TestSemanticParity` 26/26 ×3 | El fixture de playbook por goldens queda diferido (el loop completo está probado en Go por T-139; el golden cross-backend exigiría 6+ verbos más) |
| T-158 | `REPORT-W5.md` — cierre de la ola 5: 30/30 tickets (160/160 acumulados), 26 paquetes verdes con -race, paridad 26/26 ×3 con divergencias VACÍAS (F05 cerrado), 5/5 smokes web, matriz 28/28, decisiones de diseño (snapshot swap, asignación congelada, consistencia de firmas, honestidad de entrega) y la lista completa de diferidos con destino por ola | — | Los commits siguen LOCALES; push batched a pedido del usuario |
| T-159 | `internal/secretstore` — el port fiel del credentialSecretStore de referencia: envelope AES-256-GCM doble (data key fresca de 32B por valor; el valor bajo la data key, la data key bajo la root key) con AAD que ata ciphertext Y wrapped key a (org, credential, versión) — re-domiciliar la fila rompe el sello; root key desde UN secreto de proceso (inline base64/hex o _FILE, cacheada, jamás persistida) con probe de boot en cmd/api que falla rápido ante clave malformada (unset sigue legal = solo refs legacy de env); resolución org-scoped fail-closed con warn-once acotado por (fila, razón) — el silencio hacía indiagnosticable una root key partida entre réplicas; un ref managed FORJADO jamás cae al proveedor de entorno; tope 64KiB; versiones monotónicas por credencial; revoke marca revoked_at y falla cerrado. Nota Go: `splitSeal` separa el ciphertext||tag combinado de Go en las DOS columnas del schema compartido con Node | `TestSecretStoreEnvelope` (round-trip, dump sin plaintext, cross-org, tamper de AAD, resolver por (kind,name), revoke, firewall de ref forjado, topes) + `TestSecretStoreRootKeyPosture` (unset legal, malformada falla rápido, variante _FILE, clave desaparecida → resolve cerrado + write con centinela) | Tablas credentials + credential_secret_versions YA en baseline. Rutas + rotación = T-160 |
| T-160 | `internal/httpapi/credentials.go` — el loop CRUD completo: GET /credentials proyecta SIN secret_ref (bit storage managed|environment; ni valores, ni refs managed, ni NOMBRES de env vars en el wire — probado por grep del body); POST crea con exactly-one-of (secretValue|secretRef), expiry FUTURA opcional, y la tx atómica versión-cifrada + fila + audit (409 por nombre único; root key ausente → 500 secret_store_unavailable); POST {name}/bulk-update = preview del blast radius (dryRun recorre la última versión de cada workflow buscando config.credential / input.credential) y rotación bajo row lock + CAS del token ifMatch (400 sin token, 409 rancio) que inserta la versión nueva, permuta la referencia y REVOCA la anterior en un solo commit; DELETE revoca la versión managed; POST {name}/expiry exige el campo explícito (omitirlo no puede borrar una expiry viva) con ifMatch opcional. GET /credentials/health = el snapshot con el MISMO resolver org-aware del runtime (secretRefPresent), agregados de uso 30d desde usage_events, referencias por workflow en UNA pasada del DAG, y las conexiones MCP por el mismo resolver — managed y legacy no pueden derivar | `TestCredentialRoutes` (escalera de validación, no-echo por grep, preview, rotación CAS + revocación verificada por psql, expiry set/clear, delete + 404, health con referencias, ≥6 audits) | withAuditTx del reference = tx explícita + InsertAuditLogRow en Go (mismo commit-or-rollback) |
| T-161 | `credentialReadinessIssues` en el gate de producción Y el badge /workflows/readiness: UNA pasada del DAG junta nombres de credencial + aliases MCP (tope combinado 50 estricto — chequeado tras cada inserción potencial, un nodo con ambos no se cuela por 1), carga bulk de credenciales/conexiones del org, y resuelve cada referencia única A LO SUMO una vez por el MISMO resolver org-aware del runtime; cada problema = warn `credential_missing` por nodo referenciante (fila inexistente / secreto irresoluble / alias MCP inexistente / env refs MCP sin resolver con conteo m-de-n) | `TestCredentialReadiness` (2 warns → registrada-pero-irresoluble sigue warn → valor managed resoluble limpia el suyo) | DOS cierres colaterales: (1) bug real — `mcp_tool` era ejecutable desde la ola 4 (dispatch + test de motor) pero faltaba en PilotNodeTypes: el /start de httpapi lo rechazaba; el test de motor usaba StartRun directo y nunca lo pilló; (2) CAUSA RAÍZ del flake ×2 de olas previas: el breaker dispara POST-commit y un /start podía colarse tras el waitTerminal — ambos drivers de paridad ahora absorben la carrera (retry que suma el run colado a la racha y a seenRuns) + F20 asevera la pausa ANTES del ingest buffered; paridad ×5 verde |
| T-162 | `executors.FetchHTTPTarget` — el primitivo del reference en capas: MISMA validación SSRF + dial fijado + re-validación por hop + stripping de credenciales por origen + timeout/topes, SIN la política de fallo en no-2xx (los tools son dueños de su sobre y necesitan status+body del error). `internal/tools/integration.go` — el chokepoint compartido: gate (lookup org-scoped por kind+nombre → SecretStore → rate limit por ORG+CREDENCIAL, mensajes genéricos que jamás nombran refs), recorder de usage que nunca rompe el tool, y `webhook.send` como primer tool (firma Stripe `t=,v1=` HMAC-SHA256 sobre los bytes EXACTOS posteados, headers custom ≤10/≤200 chars con CR/LF rechazado y claves reservadas intocables). El registry lleva el CATÁLOGO (writeSide=true → el skip de dry-run aplica); la ejecución la intercepta el tool executor con deps del motor DESPUÉS del gate de sandbox — mismo patrón que vector.* | Unit (firma determinista, sobre never-throw en todos los modos, defensas de headers) + `TestIntegrationChokepoint` (receptor VERIFICA la firma sobre el body exacto, gate genérico, rate limit muerde, ≥3 usage rows, secreto jamás en sobre alguno) | Bug propio atrapado en el camino: el intercept quedó ANTES del gate dry-run — una validación habría disparado el webhook; reordenado |
| T-163 | `internal/tools/email.go` — email.send con la escalera de providers del reference resuelta EN CADA llamada: resend/sendgrid (reales, ambos por el seam Post guardado — cero SDKs), simulator (gate local explícito, jamás implícito) y noop como default seguro ({ok:false, "Mailer not configured"} — el contrato write-side sin throw); postura de tenant desde org config (email.provider/email.from) con fallback de env, from default onboarding@resend.dev; validaciones portadas (subject ≤998, text-o-html obligatorio, cuerpos topados, metadata ≤20 entradas cortas → tags de Resend / custom_args de SendGrid); rate gate por org (familia email, default 100/min) convertido a sobre limpio; telemetría best-effort por el recorder compartido | Unit con seams falsos (escalera de resolución, noop default, simulator por Post con URL/payload verificados, resend con bearer+tags y non-2xx, rate en sobre) | El id de SendGrid viaja en header de respuesta que FetchHTTPTarget no expone — id sintetizado best-effort, igual que la referencia |
| T-164 | `internal/objectstore` — el seam de artefactos binarios (escalera env por llamada: local con file:// + guard doble de traversal, s3 = el SEAM seleccionable con sobre honesto hasta el driver SigV4, noop default never-throw) + `internal/tools/pdf.go` — pdf.generate con escritor PDF 1.4 PROPIO sin dependencias (Helvetica base-14, paginación multi-página, headings 1-3, bold/italic por conmutación de fuente, listas, code fences en Courier, reglas ---), sustitución {{name}} con desconocidos VISIBLES, y el filename saneado como input de autor (solo último segmento, sin dot-segments — no puede escalar fuera del prefijo del tenant que arma el motor: orgs/<org>/pdf/<uuid>/); rate familia pdf default 60; html dialect rechazado honesto (follow-up) | Unit (PDF válido con todas las clases de bloque + paréntesis escapados + paginación, sustitución con typo visible, sobre noop, round-trip local con clave de tenant, filename hostil confinado — verificado que /evil NO existe en disco) | Driver S3 SigV4 + dialect HTML = follow-ups documentados (P2) |
| T-165 | `internal/httpapi/slackactions.go` — el callback PÚBLICO resuelve solo un id opaco de conexión y corre la escalera completa: HMAC v0 de Slack sobre el body CRUDO exacto (±5 min, compare constant-time, fail-closed sin secret), team firmado vs configurado, mapeo Slack-user→member acotado, y autorización del member mapeado por la capa NORMAL de roles/permisos en modo supabase (sin auto-admin de dev — sin membresía real no hay acción); el receipt de replay (PK = digest de conexión+ts+body) se reclama ATÓMICO con la mutación del item en una tx (redelivery exacta → duplicate sin segunda mutación; acknowledge fresco tras el primero → 409 CAS); acciones acknowledge/assign_to_me/open con sus audits; admin CRUD valida que la credencial slack_signing_secret exista Y resuelva antes de entregar la URL del callback; rechazos auditados (invalid_payload/team_mismatch/user_unmapped/permission_denied). +2 acciones al catálogo de audit (opened/rejected) | `TestSlackRecoveryActions` (escalera de defensa completa 401/401/403/403, acknowledge firmado con owner estampado, redelivery→duplicate, fresco→409) | El posteo SALIENTE de mensajes Slack (notificación) sigue en el canal de alertas honesto; este ticket es el camino ENTRANTE firmado |
| T-167 | `internal/zonedwindow` (módulo neutral con tzdata embebido: ParseLocalMinute/ZonedClock/Contains con cruce de medianoche) + tool `time.window` (14 ventanas máx, `at` ISO/epoch-ms, sesgo RECHAZANTE: zona/HH:MM/ventana ambigua → error; el sesgo absorbente queda en el evaluador PagerDuty — deliberadamente sin unificar). Catálogo 13→14. |
| T-166 | PagerDuty V3 completo: callback público firmado `POST /webhooks/pagerduty/{workflowId}/{nodeId}` (HMAC v1= múltiple constant-time sobre el raw body, credencial `pagerduty_webhook_secret` del Secret Store, proyección acotada sin cuerpo crudo) sobre el pipeline durable compartido extraído a `ingestTriggerEventCore` (anchor→dedupe→storm guard→buffer-on-pause→StartRun, mismo camino que webhook_received); nodo trigger `pagerduty_incident` ejecutable; 4 tools (`incident.get` proyección acotada, `policy.evaluate` puro con escalera exacta de razones y sesgo absorbente compartiendo `zonedwindow`, `acknowledge`/`snooze` write-side) vía chokepoint con nuevo seam `Fetch` method-explícito; simulador local por env gates. Hallazgo: bug del reference `compilePagerDutyFlow` (arista ack→snooze sin condición dispara snooze en eventos ignorados — skip no cascadea en NINGUNO de los dos engines); flag levantado para el repo Node. Catálogo 14→18. |
| T-168 | `POST /v1/triggers/email/ingest` sobre el pipeline durable compartido: resolver org-wide `resolveUniqueTriggerNode` (escanea DAGs latest activos; 0→404 opaco, >1→409), gate DKIM opt-out (`dkimRequired` default true), allow-list `fromDomains`, cap autoritativo 1MiB del body (413), adjuntos base64 out-of-band con cap 1MiB por adjunto → object store bajo prefijo `orgs/<org>/email/<eventId>/` (nombre sanitizado sin `..`, fallo degrada a `stored:false`), pre-chequeo de dedupe por `messageId` ANTES de subir (retry del relay no re-sube ni huérfana objetos; eventId determinista sha256 alinea fila↔claves), messageId nulo nunca dedupea (core acepta dedupe NULL + eventID inyectable); nodo `email_received` ejecutable. |
| T-169 | `POST /v1/triggers/file/ingest` (selector bucket+prefix+extensions, cap metadata 64KiB, dedupe `file:<bucket>:<key>:<etag>` — mismo etag converge, etag nuevo re-dispara) + `POST /v1/triggers/mcp/ingest` (selector alias+resourceUri+eventTypes, cap payload 64KiB, SIN dedupe — cada notificación es su propio run; el upstream es el punto de de-dup) sobre el mismo resolver org-wide + core durable; executors passthrough `file_dropped`/`mcp_server_event` con validación de config espejo del schema compartido; helper `matchTriggerNodeByID` para el recheck de rollout (email refactorizado a él). |
| T-170 | Shadow ingestion completa: callback público `POST /webhooks/external-runtimes/{id}` (HMAC `t=,v1=` ±300s sobre el raw body con credencial `external_runtime_signing_secret`), contrato CloudEvents 1.0 ESTRICTO (unión de 3 tipos observed, campos desconocidos → 400), firewall de identidades secret-shaped, receipt firmado idempotente por (connection, source, eventId), proyecciones monotónicas con upsert `WHERE last_sequence < excluded` (menor/igual → `stale` retenido, nunca aplicado), placeholders workflow/run, casos externos detected→observed_recovered SIN crédito de verified recovery, todo scrubbed + acotado (64KB). CRUD admin `/integrations/external-runtimes` (422 credencial fantasma, 409 unique, disable cierra la puerta con 404 opaco) + shadow read `observerOnly:true`. 6 tablas ya en baseline; 20 queries sqlc nuevas. |
| T-171 | Upstream health completo: `internal/upstream` (parser puro de 4 kinds — statuspage/atlassian/http_probe/custom_feed — con rollup worst-wins y TODAS las razones fail-open; poller PollOneSource/Sweep/RunSweep con fetch por el chokepoint SSRF, ticker de 1min en cmd/api junto al retention sweep), suscripción por tags `upstreamHealthSources` en el save body (columna workflow_versions, ≤50 nombres, la versión LATEST decide), auto-pausa `paused_upstream_degraded` idempotente (`WHERE status='active'`, audit una vez por flip real) + resume simétrico, CRUD admin `/upstream/sources` + Check-now inmediato. La fila /start del pause table ya existía (`upstream_degraded` 409); trigger ingest ya bufferea cualquier estado no-activo. FAIL-OPEN probado: feed inalcanzable/incomponente/no-parseable no pausa NADA ni mueve el estado derivado. |
| T-172 | `internal/tools/dbquery.go`: validación SQL cerrada (sin `;`, sin comentarios, verbos DDL/sesión prohibidos, clases de verbo por tool, placeholders contiguos $1..$n == len(params)) ANTES del gate (SQL malo no consume presupuesto de rate), `db.schema.describe` (identificadores simples, information_schema acotado 2000 filas, agrupado por tabla) + `db.query.read` (SELECT envuelto `limit maxRows+1` → `truncated`, SET LOCAL statement_timeout en tx). Pools externos: 1 conexión por credencial, máx 5 por org/proceso, swap por fingerprint sha256 del DSN, evicción LRU; `safeDbError` redacta `postgres://` + formas de secreto (cap 300). Seam `OrgID` nuevo en IntegrationDeps. Catálogo 18→22. |
| T-173 | `db.query.write` (un INSERT/UPDATE/DELETE parametrizado, rowCount por CommandTag) + `db.query.transaction` (1..10 sentencias SELECT/DML en UNA tx: fallo a mitad revierte TODO — probado con violación NOT NULL que restaura el update previo), ambos `WriteSide` (skip de dry-run del executor + bits pineados en unit test). Aislamiento de tenant NO por reescritura SQL: el DSN/rol/RLS del cliente manda; Janusly solo aporta el gate org-scoped (credencial kind `postgres`), rate limit org+credencial (org config `integrations.db.rateLimitPerMin` → default 60) y usage rows por llamada. |
| T-174 | `loop.mode="for_each"` completo: un tool registrado por item DENTRO del mismo nodo (pool ordenado de workers 1..20, default 4; jamás un primitivo de cola), ≤1000 items, TODOS los inputs por-item renderizados ANTES del primer efecto (strict falla el nodo sin procesar parcialmente), exactamente UN presupuesto de fallas (count O porcentaje — ambos → error de config), throws y `{ok:false}` cuentan como falla, skips de dry-run aparte; diagnóstico acotado (64KB por item vía safe-persist, 700KB agregado con sentinel del reference, muestra de fallas ≤50, mensajes ≤300). Escalera de intercepción EXTRAÍDA a `executeRegisteredTool` (tool node y loop despachan idéntico). Canal writeSide punta a punta: ExecErrorShape.WriteSide → ExecError → error_json → `RetryOrFail` NUNCA re-intenta nodo completo (runtime.ts:360); probado con retry declarado maxAttempts=3 y attempts==1. Modo desconocido sigue fallando honesto. |
| T-175 | Nodo `subworkflow` ejecutable: rama propia del dispatcher (necesita el engine), guard de recursión org config `subworkflow.maxDepth`→env→5 con walker acotado a 100 que corta en linaje de replay, carga org-scoped del hijo (pin exacto / rollout en producción sin pin / latest con padre ACTIVO), precedencia de input (config.input — incluso null — gana; si no, input del padre; secretos redactados), y el contrato ATÓMICO: la tx de StartRun del hijo TAMBIÉN comete el checkpoint running→waiting EXACTO del padre + ambos eventos (`subworkflow.started` + `node.waiting`) — los roots del hijo solo son reclamables junto con la pausa del padre. Propagación de validación al hijo. `ParentCheckpoint` en StartInput; el sentinel Waiting solo guía al worker (su CAS no-opea). |
| T-176 | Handoff terminal durable: el flip terminal del hijo arma `parentNotificationAfter` EN EL MISMO UPDATE (`MarkRunTerminalFromRunning` extendido a links ejecutables); el notifier inmediato (worker post-completion) asienta el checkpoint exacto del padre — éxito: CAS waiting→succeeded con output del hijo + `subworkflow.completed` + readiness (solo si el padre corre; un padre fallido SE ASIENTA sin reabrirse); fallo: CAS waiting→failed con `firstChildFailure` + flip del run padre (trampolín: el flip arma el marcador del abuelo y `DeliverParentNotifications` sube la cadena) — y limpia el marcador solo tras asentar. Rechequeos de crash-window idempotentes en ambas ramas. Reconciler con lease (`FOR UPDATE SKIP LOCKED`, lease 60s, cap 500) cada minuto en cmd/api; test que simula la ventana de crash y verifica reparación + marcador limpio. |
| T-177 | Nodo `schedule` completo sobre due-clock Postgres (migración 00005 `next_fire_at` + índice parcial; el patrón de campañas — sin BullMQ): parser cron propio de 5 campos (`internal/cron`: *, números, rangos, steps, listas, OR clásico dom/dow, cota de 4 años contra fechas imposibles), `SyncWorkflowSchedules` REEMPLAZA el set de entradas en la MISMA tx del save (y rollback; restore re-registra; soft delete las borra en su tx), sweep con lease `FOR UPDATE SKIP LOCKED` cada 15s que dispara contra la versión EXACTA de la entrada con guard de padre activo (huérfana → delete; tombstone/cross-org → delete; nodo removido → delete), fila `schedule` del pause table: tick en pausa se DESCARTA con audit `schedule.tick.dropped` y el reloj avanza (nunca thundering herd al reanudar), cron corrupto → `schedule.entry.disabled`. Executor passthrough validando cron. |
| T-178 | Crons de sistema restantes, forma piloto (sweeps con ticker, sin BullMQ): (a) auto-healing supervisado — barrida con doble opt-in (env `JANUSLY_AUTO_HEALING_ENABLED` + org `autoHealing.enabled`, sin fallback por tenant), clusters por firma normalizada freq≥2, loop-breaker por (org,firma) en ventana configurable, idempotencia por dead_letter, propuesta DETERMINISTA $0 (`harden_retries`: retry exponencial + timeout×2 — el LLM queda en la superficie interactiva aipatch, decisión de costo documentada), validación sandbox vía `ReplayDeadLetterAsValidation` con snapshot parcheado, watcher promueve a `validated`/`validation_failed`; rutas de decisión (`/auto-healing/pending|{id}|decide|scan`) con CAS en `validated`, ack de riesgo obligatorio para evidencia `static`/`writes_skipped`, apply = redrive con fix-snapshot; (b) purga de consent de memoria — sweep horario con re-lectura defensiva del config al disparar (re-otorgar dentro de la ventana hace invisible al org, sin bookkeeping de cancelación), audit `memory.bulk.purged`; (c) heatmap de cron-observabilidad — `GET /workflows/{id}/schedule-history` (grid UTC día×hora 90d/5000 filas, celdas `anomaly` conservadoras, preview next-5 por entrada). |
| T-179 | Verificación del posture de checkpoints vencidos: el piloto NO necesita el reconciler dedicado del reference porque su reloj de wakeups vive en Postgres — un timer que venció durante una caída de polling simplemente dispara al reanudar (test: wait_until parkeado, gap sin workers con el wakeup vencido sobreviviendo en `go_pilot_wakeups`, reanudación → exactamente un `node.resumed`); la otra clase de crash (worker muerto a mitad de ejecución) la cubre el reaper existente (test: nodo `running` envejecido → failed ruidoso, run failed). Documentado como decisión de arquitectura, no como gap. |
| T-180 | Superficie de producto completa: snippets (9 built-ins portados EN CÓDIGO — nunca persistidos, mutación de `builtin:` → 409, lista los antepone, CRUD custom con colisión de nombre 409, beacon de inserción `/{id}/inserted` solo-auditoría), solution packs (los 3 pack.json del reference EMBEBIDOS VERBATIM vía go:embed con validación al boot — ids únicos + workflowJson parseable; catálogo con hints de dependencias solo-EXISTENCIA, instalación como draft con id determinista POR ORG — `<packId>-<hash8(org)>` porque workflows.id es PK global — y re-instalación que apila versiones + re-sync de schedules; sample-run = sandbox `replayMode=validation`; inject-failure = run determinista que aterriza un dead letter real sin red), onboarding derive-on-read (señales SQL de estado durable — credencial/audit pack_imported/run verde/DLQ/DLQ resuelto∨recovery item — fila solo como high-water monotónico + latch de status, completación auditada UNA vez vía CAS, restart re-deriva desde la época, toggle `onboarding.enabled`). |
| T-181 | Health rollup + SLO + delta: `internal/health` puro (6 categorías con TODAS las fórmulas/constantes del reference — pesos que suman 1.0 pineados, neutral 80 para lo sin señal, bandas lineales de costo/latencia, penalizaciones DLQ/retry/secretos), evaluador SLO portado (piso de muestra 5, umbral nulo nunca rompe; los breaches NO alteran el score), señales en UNA query SQL (ventana 30d, p95 percentile_cont sobre eventos terminales, costo/tokens de usage_events, atribución de versión EFECTIVA: los runs sin pin llevan `workflow_version_id = workflowId` — convención del piloto — y su versión se deriva contando versiones guardadas al momento del run), SLO declarado en el save body → `workflow_versions.slo_json`, `GET /workflows/health` + `GET /workflows/health/delta` (corte por versión antes/después, contador de runs, gate MIN_RUNS=5, same-failure por firma normalizada contra los dead letters post-corte). |
| T-182 | Metadata + organización completa: upsert total de la fila (owners/tags/descripción/Slack/Linear/severidad/folder/runbook/guía-AI con caps; el audit proyecta `aiGuidanceMarkdown` a `{configured, bytes}` — preferencias libres de AI jamás persisten en audits), rutas ESTRECHAS `/folder` y `/tags` que tocan solo su columna (drag del Flows list no arrasa la fila — probado), GET de metadata ausente = 200 con null (nunca 404 en primer load), dropdowns distinct de tags (jsonb_array_elements_text) y folders excluyendo tombstones (probado con soft delete), y las 6 operaciones bulk de colección (folders rename/delete/assign + tags assign/rename/delete) org-scoped con filtro de ids poseídos (los ajenos se saltan silenciosamente) y audits con conteos. |
| T-189 | Eval datasets completos: creación con el GATE de opt-in (`accepted AND eval_consent` — sin consent no hay elegibilidad, punto), snapshot inmutable en una tx (firma de falla derivada del error_json del dead letter vía el normalizador compartido; el comentario del operador es el input context, scrubbed en escritura Y RE-scrubbed en lectura/export — defensa en profundidad, probado con un token sk- plantado), colisión de nombre 409, export jsonl/json con Content-Disposition, hard delete de dataset + ejemplos, audits created/exported/deleted. |
| T-190 | Experiment harness completo: `internal/experiment` data-agnóstico (el route resuelve refs en arms aplanados), runner secuencial (paralelo racearía presupuesto/rate limit) con el contrato AI-fallback total — cliente nil completa determinista con `llm_not_configured`, throw por lado → score 0, NUNCA lanza — y 3 scorers (`string_equality` indulgente, `json_schema` REUSANDO el validador de inputs declarados de domain con fallback a igualdad, `llm_judge` con degradación Jaccard determinista y framing de DATOS anti-inyección), recomendación SOLO-CONSULTIVA (`MIN_SCORE_DELTA=0.05`, costo reportado pero jamás gate), cap 200 ejemplos, `POST /experiments/run` persistiendo summary + audits started/completed/promotion_suggested. |
| T-191 | SCIM 1/4: webhook `POST /webhooks/workos/directory` con firma `t=,v1=` fail-closed (secreto vacío rechaza TODO; escalera exacta de razones missing_secret/missing_header/malformed_header/expired/future_timestamp/signature_mismatch, compare constant-time, ±300s) sobre el raw body exacto; seam de org-binding = fila `scim_directories` por `provider_directory_id` (jamás el tenant del payload); attach/update/revoke admin (409 segundo directorio, status inmutable por POST — revoke = HARD delete por DELETE (libera los índices únicos para el re-attach; el webhook posterior responde `unknown_directory` y la rama `directory_revoked` queda defensiva como en el reference), re-attach probado absorbiendo la membresía SCIM-owned del ciclo anterior); fallos de firma auditados contra el tenant "default" (forense sin org). 30 queries sqlc nuevas sobre las 6 tablas ya en baseline. |
| T-192 | SCIM 2/4: dispatcher con el orden determinista de guardas del reference — replay (`scim_processed_events` ON CONFLICT, 0 filas = replayed) → malformed_timestamp → dispatch por tipo, y el claim se LIBERA (best-effort) si el dispatch falla con error real para que el retry de WorkOS re-procese (guard-skip NO libera — replay legítimo); out-of-order estricto por `last_event_timestamp`; resurrección (create sobre inactivo con ts no-más-nuevo → blocked; update sobre inactivo → blocked `update_while_inactive`); colisión con asimetría deliberada: create ABSORBE filas SCIM-owned (`invited_by='scim:webhook'`) y bloquea human-invited intactas, re-key bloquea CUALQUIER fila en el email nuevo; policy de dominios vía org config `auth.allowedEmailDomains` (el catálogo ya la tenía; primer consumidor Go); membresía keyed por `(org_id, lower(email))` con `user_id=email` en insert y preservación de `user_id`/`invited_by` en update; deprovision borra membresía + join rows y marca estado inactivo; delete de usuario desconocido limpia join rows huérfanos. La respuesta del webhook siempre 200 `{ok, processed, action\|reason}` tras firma+JSON válidos; I/O real → 500. |
| T-193 | SCIM 3/4: `deriveScimRole` v2 puro (mayor rango gana viewer<editor<admin, rol desconocido rank -1 jamás gana, sin grupo mapeado → `defaultRole` byte-igual al comportamiento flat pre-v2) + eventos de membresía `group.user_added`/`user_removed` (join idempotente ON CONFLICT; persistir/borrar PRIMERO y recomputar después; sin estado activo → solo audit `roleRecomputed:false` — group-before-create se recoge en el create posterior) + `group.created/updated` upsert de `scim_group_state` + `group.deleted` que captura afectados ANTES de borrar joins y recomputa (los roles derivados del grupo borrado caen a `defaultRole`). Sin guarda out-of-order por-membresía (la join table no lleva timestamp): postura v1 aceptada del reference — nunca escala más allá de un mapeo configurado. |
| T-194 | SCIM 4/4: CRUD admin de mapeos grupo→rol (`members.role_set`; grupo debe existir en el estado sincronizado → 404 typo-guard, duplicado 409, update con before/after auditado, delete auditado), picker `GET /org/scim/groups` (limit 100/200), y `POST /org/scim/resync` — re-deriva con el MISMO `deriveScimRole` del webhook (jamás inventa autoridad), cap 5000 con over-fetch cap+1 para `capped` honesto, `invited_by` omitido para preservar el actor de aprovisionamiento original, fallos por-miembro aislados en `skipped`, UN audit `org.scim.resynced` con conteos. Colateral: el pin de paridad del catálogo de audit (147) llevaba roto desde olas previas — 9 acciones raw-audit (upstream/schedule/auto-healing/memoria/slack) estaban infladas dentro de `knownActions`; extraídas junto con las 19 scim.* a un mapa estático `rawAuditActions` separado (acciones del chokepoint crudo `audit()` del reference, fuera del union tipado) y `TestAuditCatalogPinned` vuelve a verde con el union en 147 exacto. Sin panel web en el piloto (API-first, como el resto de la ola); fixtures WorkOS puros — jamás WorkOS real. |
| T-183 | Barrido F1 terminal con método honesto: enumeración de TODOS los call sites `api()`/`downloadFromApi()` del web + sondeo contra el binario Go en el WIRE REAL del cliente (GETs del set `V1_READ_PATHS` → `/v1` con envelope; el resto legacy crudo; `downloadFromApi` siempre crudo). Siete cierres implementados: catálogo de 15 templates del reference EMBEBIDO VERBATIM (extraído con node type-stripping a `assets/templates.json`, decoración i18n incluida), `schedule-preview` `{valid,nextFires[3]}` sobre `internal/cron`, aliases `/v1` de health y run/usage (cores refactorizados, un handler dos wires), `consent-status` con el union de purge del reference derivado del estado durable del pilot, `calibration-status` (constantes 30/20 pineadas), y `GET /mcp/connections` con conteos de descriptors. El smoke nuevo de TODOS los tabs (15) sin pageerrors cazó un bug real: el panel de packs caía al ErrorBoundary porque `packView` omitía `failureFixtures`/`nodeCount` (los pack.json embebidos SÍ los traían; la struct los tiraba al parsear) — proyección alineada a `toPublicPack` y el smoke ahora exige la CARD renderizada, no solo "no crasheó". F1-GAPS.md reescrito a estado terminal: cero rutas sin clasificar (tabla de servidas + tabla de divergencias con decisión: AI explain/review, billing/budget por-workflow, SLO-en-save, recovery cases V2, causal, replay-lab, identidad multi-org — todas degradan limpio, probado). |
| T-184 | Strangler + shadow completos. (1) `CUTOVER-MAP.md` versionado: cinco fases por familia de ruta (núcleo de ejecución → operación/recuperación → administración → superficies AI → colas del cutover total) con ejemplo Caddy/nginx del split y rollback = re-apuntar la familia (estado en el MISMO Postgres, sin migración de datos); ninguna familia con exclusión permanente (dirección 2026-07-31). (2) Comparador dual-run `conformance/run-dual.mjs` (`make dual`): corpus determinista idéntico contra el reference pinneado (via run-reference-stack) Y el binario Go, diff normalizado (ids/timestamps/uuids/prosa fuera; arrays de nodos ordenados por nodeId; ids de workflow únicos por corrida — PK global) que FALLA ante cualquier diff fuera de la lista anotada de divergencias esperadas (traceId OTel, granularidad del event-stream, runCount por la convención de version-id, artefacto env-overlay del reference, taxonomía de nombres de error por runtime). Resultado: **27/27 idénticos**. El comparador pagó su costo cazando y cerrando OCHO bugs de paridad reales: tool `http.request` AUSENTE del catálogo (añadido vía FetchHTTPTarget con el mismo chokepoint SSRF), hook de auto-creación de recovery items en el insert del DLQ (port completo: gate `recovery.autoCreateItems`, debounce por (workflow, firma) con attach idempotente por tabla hija + occurrenceCount, severidad default p1..p4 del metadata, SLA por severidad con overrides `recovery.slaPolicies`) más su overlay `recovery` en `/v1/dlq` (estaba hardcodeado a null), vocabulario de severidad del metadata corregido a p1..p4 (low..critical era invención del pilot — el picker del web manda p-levels), `GET /members` a array desnudo, respuesta completa de `POST /org/config` (fila resuelta entera) + `allowEmpty`/`fractional` en el read, `issues` top-level en los rechazos de validación legacy (encoder con `legacyExtras`; /v1 conserva params), `metadata:{tags:[]}` defaulteado en el dagJson persistido y snapshot de workflow enriquecido (orgId/createdBy/input/metadata) en `runs.inputJson`, y proyecciones workflowId/workflowName de runs y DLQ desde el snapshot propio del run (coalesce del reference) + `errorJson.name` siempre presente. |
| T-185 | HA final en tres piezas. (1) **Kill-failover** `make failover` (`conformance/run-failover.mjs`): dos instancias sobre la MISMA base, 30 runs alternados + SIGKILL (sin drain) a una a mitad de vuelo + 30 runs más por el sobreviviente — las 61 corridas llegan a terminal (59 succeeded + 1 reaped: el claim del replica muerto cae RUIDOSO al DLQ vía reaper, jamás se pierde ni se re-ejecuta en silencio), exactly-once verificado nodo a nodo (attempts=1), sobreviviente sano todo el tiempo, y la instancia caída se reincorpora y sirve; ×3 corridas idénticas. Knobs nuevos: reaper interval/threshold por env (`JANUSLY_GO_REAPER_*_MS`) + override EXPLÍCITO del floor de 15m con warning ruidoso (el floor absorbía el threshold del arnés — primer hallazgo). (2) **Lane HA** `make test-ha` ×3 verde (dos engines in-test, exactly-once cross-instancia). (3) **Soak 24h** lanzado sobre base AISLADA (`janusly_go_soak`, puertos 4650/4651, pools acotados 5+6) con k6 sostenido; veredicto automático del arnés (crecimiento >10% primer-vs-último cuarto = falla) aterriza en `conformance/perf/SOAK.md` al completar. HALLAZGO MAYOR del ticket: la coexistencia soak+suite reventó `max_connections=100` y el pico de 104 conexiones destapó un LEAK REAL — el stream hub hace `Hijack()` de su conexión LISTEN con contexto Background: invisible para `pool.Close`, una conexión filtrada POR HARNESS de test para siempre. Fix: `NewV1HandlerWithShutdown` cancela el hub; los harnesses lo llaman en cleanup. Ese leak habría mordido producción multi-réplica con reinicios frecuentes. |
| T-186 | Revisión de seguridad ejecutable, no prosa: `SECURITY-REVIEW.md` con inventario por superficie y su test. Nuevo: sweep authz de rango EDITOR (`TestRouteRegistrySweepAsEditor` — admin-gated → 403 de rol, permisos fuera del set default de editor → 403 de permiso, el resto pasa ambas capas; junto al sweep viewer existente la matriz por rango queda completa), matriz SSRF del tool `http.request` recién añadido (metadata AWS + loopback bloqueados; proyección JSON declarada verde), y scrub E2E por el WIRE (`TestSecretScrubEndToEnd`: secreto plantado en config+input de un run fallido → /v1/dlq, /dlq?id= y /audit limpios con `[redacted]` presente, y `JANUSLY_PRODUCTION_MODE=true` → /start 422). HALLAZGO con flag al reference: `runs.input_json` está FUERA del chokepoint safe-persist en AMBOS engines — un secreto hardcodeado sale por el detalle del run en dev; postura sancionada `{{secret.X}}` + gate de producción, riesgo residual documentado y task levantado al repo Node (precedente: dead_letters.workflow_json SÍ se key-redacta sirviendo replays). Inventario de 5 verificadores de firma entrante con fail-closed probado. |
| T-187 | Cierre de ola en tres piezas. (1) **SDK Python contra Go**: lane `node conformance/run-sdk-live.mjs` — boot del binario con `JANUSLY_API_SERVICE_TOKEN` real, seed de membresía (service-token NUNCA auto-otorga) + workflow guardado, y `tests/test_live_go.py` (pytest, skip-sin-env para mantener la suite hermética) ejercitando el MISMO wire: start dos-pasos (latest→start), poll_until_terminal, iterator paginante de runs, mapeo del 403 uniforme `runs_forbidden` a `JanuslyApiError`, métricas de recovery y cancel-de-terminal como conflicto limpio — **5/5 al primer intento** (el único ajuste fue del test: `runs.list` es generador). Suite completa del SDK 84 passed + mypy limpio. (2) **`RUNBOOK-CUTOVER.md`**: switch por tenant (mismo Postgres = solo tráfico), ventana sin campañas/rollouts, smoke de 2 min, monitoreo 24h con umbrales del soak, rollback <1 min re-apuntando el proxy + el caso divergente al corpus ANTES de reintentar, y los no-hacer (dos schedulers activos del mismo tenant; arreglar divergencias editando datos). (3) **`REPORT-W6.md`**: evidencia por área (dual 27/27, smoke 15 tabs, failover ×3, HA ×3, soak 24h en curso, seguridad, SDK 5/5, suite+lint verdes con el soak vivo), las 4 lecciones de la ola, diferidos con destino, y la plantilla go/no-go llenada — **recomendación: GO** (fase 1 del strangler por un tenant interno; el veredicto 24h es autónomo y no bloquea). |
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

## 13. Ola 2 — 50 tickets (F0.5 → F1 → F2 temprana)

Protocolo idéntico (§0): secuencial, criterios de aceptación, tests, commit
por ticket, resumen post-commit, estado en esta tabla. Las cards viven
compactas aquí; el detalle de paridad se lee de la fuente al ejecutar.

### Tabla de seguimiento — ola 2

| # | Ticket | Fase | Pri | Estado |
| --- | --- | --- | --- | --- |
| T-019 | Pool DB configurable + pools separados API/workers + retest 50VU | F0.5 | P0 | done |
| T-020 | Reaper de nodos atascados (`running` huérfanos → requeue/fail acotado) | F0.5 | P0 | done |
| T-021 | Cancelación de run (`POST /v1/run/cancel`, semántica Node: cancellable statuses) | F0.5 | P0 | done |
| T-022 | Recaptura goldens faltantes (save-éxito, dlq-replay) + golden de cancel | F0.5 | P1 | done |
| T-023 | Diagnóstico flake delayed-retry + captura de detalle en arnés | F0.5 | P1 | done |
| T-024 | Métricas Prometheus del engine (claims, completions, profundidad, latencia) | F0.5 | P1 | done |
| T-025 | Lane `make ci` local (build+lint+test+parity, una orden, exit code honesto) | F0.5 | P1 | done |
| T-026 | Keyset real en `/v1/runs` + `/v1/workflows` (cursor `<iso>|<id>` Node-compatible) | F0.5 | P0 | done |
| T-027 | Rutas workflows read: GET /v1/workflows, /latest, /versions (formas golden) | F1 | P0 | done |
| T-028 | Config CORS + headers paridad http.ts (el web browser habla con Go) | F1 | P0 | done |
| T-029 | Arranque del web real contra Go: inventario de gaps de la Home/Activity (doc) | F1 | P0 | done |
| T-030 | GET /health con forma Node (rateLimiter/queue públicos-seguros) | F1 | P1 | done |
| T-031 | SSE `/runs/:id/stream` (pub del engine → hub API; web usa fetch+ReadableStream) | F1 | P0 | done |
| T-032 | Rutas /run/usage + /workflows/trash + /workflows/:id/restore (stubs honestos donde aplique) | F1 | P1 | done |
| T-033 | Soft-delete de workflows (DELETE /v1/workflows/:id + tombstone + exclusiones) | F1 | P0 | done |
| T-034 | Rollback (`POST /v1/workflows/rollback`, pre-checks Node) | F1 | P1 | done |
| T-035 | Smoke Playwright del web contra Go (Flows list + Activity + run detail) | F1 | P0 | done |
| T-036 | Executor `json.parse` + tool registry mínimo (`listTools()` para AI Studio read) | F2 | P1 | done |
| T-037 | `parallel_fork` + `join` (shells declarativos sobre readiness, validación 3 reglas) | F2 | P1 | done |
| T-038 | Executor `loop` modo map puro (legacy contract) | F2 | P1 | done |
| T-039 | Edge conditions con evaluación completa en validación (`validateExpression` en save) | F2 | P2 | done |
| T-040 | Trigger ingest: `POST /v1/webhooks/:workflowId` → startRun con evento normalizado | F2 | P1 | done |
| T-041 | `webhook_received` executor passthrough + fixture trigger e2e | F2 | P1 | done |
| T-042 | Validación production-mode (readiness gate subset: retries, bounds, secretos) | F2 | P2 | done |
| T-043 | Org config subset (`org_configs` read + http bounds por tenant en executor) | F2 | P2 | done |
| T-044 | Réplica de `/dlq/counts` + clusters básicos (firma de error agrupada) | F2 | P2 | done |
| T-045 | Replay campaigns mínimo (2..N mismos-firma, paced, cancelable) | F2 | P3 | done |
| T-046 | Paridad lane A ampliada: F11-F20 (cancel, fork/join, loop, webhook, keyset) | F2 | P0 | done |
| T-047 | Postgres 15 floor: lane integración con `JANUSLY_POSTgres_IMAGE` pg15 | F2 | P2 | done |
| T-048 | Bench regresión: `make bench` guarda serie temporal en conformance/perf | F2 | P2 | done |
| T-049 | Hardening SSRF extra: redirect cross-origin strip de headers credenciales | F2 | P1 | done |
| T-050 | Journal ola 2 parcial + revisión de divergencias acumuladas | F2 | P1 | done |
| T-051 | Streaming HTTP opt-in (`bodyMode:"stream"` → preview acotado) | F2 | P2 | done |
| T-052 | `csv.fetch`/`csv.parse` port (RFC 4180 compartido, bounded sample) | F2 | P2 | done |
| T-053 | Retention sweep mínimo (`system:retention`: purga workflows tombstone >30d) | F2 | P2 | done |
| T-054 | `wait_until` archivo de timers vencidos masivos (lote + fairness) | F2 | P3 | done |
| T-055 | Métricas de valor: verifiedRecovery p50/p90 sobre redrives reales | F2 | P2 | done |
| T-056 | MCP: tools de inspección extra (runs.list, workflows.list) + paginación | F2 | P2 | done |
| T-057 | MCP: consent gate de escrituras (env + org flag, paridad guardMcpWrite) | F2 | P1 | done |
| T-058 | API keyset en eventos: paridad exacta cursores Node↔Go round-trip test | F2 | P1 | done |
| T-059 | Idempotencia de `POST /start` (header `Idempotency-Key` opcional) | F2 | P3 | done |
| T-060 | Runbook de operación del binario (systemd/launchd, backup, upgrade) | F2 | P2 | done |
| T-061 | Fuzzing de gramáticas (go-fuzz corto: expresiones + templates) | F2 | P2 | done |
| T-062 | Property tests del queue (invariantes: exactly-once, no-orphan, terminal) | F2 | P2 | done |
| T-063 | Paridad de `/v1/dlq` filtros server-side (status, nodeId, workflowId) | F2 | P2 | done |
| T-064 | Web: panel DLQ + redrive contra Go (smoke Playwright) | F1+ | P1 | done |
| T-065 | Web: aprobar/resume desde la UI contra Go (smoke Playwright) | F1+ | P1 | done |
| T-066 | Consolidación: goldens re-run completo + parity F01-F20 verde | F2 | P0 | done |
| T-067 | Números ola 2: retest carga con pools nuevos + tabla evolución | F2 | P1 | done |
| T-068 | Informe de ola 2 (REPORT-W2.md): estado F1/F2, gaps restantes, riesgo | F2 | P0 | done |


## 14. Ola 3 — Plataforma mínima creíble (T-069..T-098)

**Tesis:** lo que separa el pilot de un despliegue serio no es runtime sino
plataforma. Esta ola cierra las cuatro transversales (auth real, audit,
limiter, catálogo de org config), valida HA multi-instancia y deja el
contrato v1 generado y vigilado. Protocolo §0 idéntico: secuencial,
fuente Node al pin antes de portar, tests, commit por ticket, fila(s) §9,
resumen. Regla de esta ola: **ninguna mutación nueva sin audit desde el
día que exista el chokepoint (T-079)**.

### Tabla de seguimiento — ola 3

| # | Ticket | Área | Pri | Estado |
| --- | --- | --- | --- | --- |
| T-188 | Migraciones en Go puro (goose embebido): baseline + conversión + boot check — SE EJECUTA PRIMERO | schema | P0 | done |
| T-069 | AuthContext + PROVIDER_CHAIN (seams de 4 modos, grant = org_members) | auth | P0 | done |
| T-070 | Modo Supabase: verificación JWT + resolución de membresía | auth | P0 | done |
| T-071 | Modo service-token (sin auto-admin) + modo dev-headers endurecido | auth | P0 | done |
| T-072 | Catálogo de permisos (41 claves) + `requireRole` por rango | auth | P0 | done |
| T-073 | `requirePermission` + anotación role/permission en el registry de rutas | auth | P0 | done |
| T-074 | Roles custom por org (`org_roles`, inheritsFrom cerrado, fail-closed) | auth | P1 | done |
| T-075 | Guard anti-lockout de admin (coerción auditada, excepción custom-admin) | auth | P1 | done |
| T-076 | Rutas members: invite / role / delete (sin cascada, fallback getOrgRole) | auth | P1 | done |
| T-077 | Overrides de permisos + CRUD de roles custom (409 role_in_use, revert built-in) | auth | P1 | done |
| T-078 | Gate de arranque en producción (sin Supabase → rehusar salvo ALLOW_DEV_AUTH_HEADERS) | auth | P0 | done |
| T-079 | Chokepoint de audit: catálogo tipado de acciones + helper `auditAction` | audit | P0 | done |
| T-080 | `withAuditTx` (entidad + fila de audit comprometen juntas) | audit | P0 | done |
| T-081 | Retrofit de audit a TODAS las mutaciones existentes (save/cancel/redrive/campañas/trash/MCP) | audit | P0 | done |
| T-082 | `GET /audit` (admin, filtro por prefijo de acción, keyset, cap 200) | audit | P1 | done |
| T-083 | `safePersistPayload` formal (redacción por valor + claves + cota de bytes + centinela) | audit | P1 | done |
| T-084 | Rate limiter en Postgres (fail-open) + observabilidad de degradación | limiter | P0 | done |
| T-085 | Limiter cableado: API global, storm-guard de triggers, MCP writes 60/min | limiter | P1 | done |
| T-086 | Catálogo completo de org config (tipado, guards anti-secreto, GET/PUT + audit) | config | P0 | done |
| T-087 | Consumidores del snapshot: requireSavedWorkflow, TTLs, ventanas de retención por org | config | P1 | done |
| T-088 | Retención completa por org: run_events / audit_logs / usage_events (CTE por tabla, acotada) | config | P1 | done |
| T-089 | Sustrato usage_events + seam de recorder (forma `llm.completion` lista para ola 4) | usage | P1 | done |
| T-090 | `GET /run/usage` real + agregado de costos acotado (100 grupos + resto) | usage | P2 | done |
| T-091 | Health de dos niveles: `/health` público-seguro + `/system/queue` admin (profundidad desde Postgres) | obs | P1 | done |
| T-092 | Paridad de nombres Prometheus + Resource OTel (`service.name=janusly`, instance id) | obs | P2 | done |
| T-093 | Lane HA: DOS instancias del engine sobre una base — property + race suites verdes | HA | P0 | done |
| T-094 | Singletons con lease o prueba de seguridad concurrente por bomba (campañas/retención/timers) | HA | P1 | done |
| T-095 | Soak: `make soak` (k6 sostenido ≥1h, vigilancia de RSS/goroutines, reporte) | HA | P1 | done |
| T-096 | Manifiesto de contrato v1 + OpenAPI generado + guard de deriva en `make ci` | contrato | P1 | done |
| T-097 | Lane CI de GitHub Actions para `go/` (build+lint+test+parity con Postgres de servicio) | contrato | P2 | done |
| T-098 | Informe de ola 3 (REPORT-W3.md) + corte de divergencias | cierre | P0 | done |

### Cards — ola 3

### T-188 · Migraciones en Go puro — P0 (primero de la ola)
**Objetivo:** decisión del usuario (2026-07-31): la propiedad de esquema y
migraciones del pilot pasa YA a una herramienta del ecosistema Go —
liviana, Go puro, sin dependencias tipo Java. Elegida: **goose**
(pressly/goose, Go puro, migraciones SQL embebibles con `embed.FS` en el
binario — encaja con la tesis un-binario).
**Espec:** (1) baseline: el esquema compartido completo al pin como
migración 00001 (dump limpio; en bases EXISTENTES se marca aplicada sin
ejecutar — goose sobre tabla de versiones propia `go_pilot_goose_version`
para no chocar con drizzle). (2) Convertir `migrations/0001_go_pilot.sql`
a migraciones goose numeradas. (3) `make migrate` deja de delegar en
`pnpm migrate`: `go run ./cmd/migrate` (o subcomando del binario) aplica
todo; el lane pg15 y el RUNBOOK se actualizan (camino sin repo Node ya
real). (4) Boot check: el binario verifica la versión goose al arrancar y
rehúsa si falta (paridad con `assertMigrationsApplied`). (5) Protocolo de
sync: cada sync con develop revisa `packages/db/migrations` nuevas y las
ESPEJA como migraciones goose (regla §0 ampliada).
**Acepta:** [ ] base fresca: `migrate` desde cero SIN pnpm deja la suite
verde · [ ] base existente: baseline marcada sin re-ejecutar, migraciones
nuevas aplican · [ ] binario rehúsa arrancar des-migrado · [ ] pg15 lane
verde por el camino nuevo · [ ] RUNBOOK + §9 actualizados.

### T-069 · AuthContext + PROVIDER_CHAIN — P0
**Objetivo:** el resolver real de identidad, con la arquitectura de la
referencia: una cadena de proveedores donde el PRIMERO que resuelve gana y
**el grant es la fila `org_members`** (nunca el token solo).
**Espec:** leer `docs/architecture/auth-and-identity.md` + el resolver Node
antes de portar. `internal/auth`: `Context{OrgID, UserID, Role, Mode,
ServiceTokenSuffix}` + `Provider` seam (`Resolve(r) (*Context, error)`);
`providerOrgHint` es selector de alcance, no autoridad. El middleware
`auth()` actual de httpapi pasa a delegar en la cadena.
**Acepta:** [ ] cadena configurable con orden estable · [ ] sin proveedor
que resuelva → 401 con la forma Node · [ ] dev-headers sigue byte-igual
para el harness · [ ] tests de precedencia entre modos.

### T-070 · Modo Supabase (JWT + membresía) — P0
**Objetivo:** producción real: token de Supabase → usuario → fila
`org_members` del org pedido.
**Espec:** verificación de firma según lo que use la referencia (leer su
verificador: secreto HS/JWKS), extracción de `sub`, resolución de
membresía por `(orgId, userId)`; expiración → 401; membresía ausente →
403 (la expulsión expira la sesión en el siguiente request, semántica del
member-delete). Config por env igual que Node (`SUPABASE_*`).
**Acepta:** [ ] token válido + miembro → contexto con rol real · [ ] token
válido sin membresía → 403 · [ ] firma inválida/expirada → 401 · [ ]
matriz de 5+ tokens malformados (alg none, aud equivocada, exp pasada).

### T-071 · Service-token + dev-headers endurecidos — P0
**Objetivo:** los otros dos modos productivos de la cadena.
**Espec:** service-token compara contra `JANUSLY_API_SERVICE_TOKEN`
(comparación constante), **no auto-otorga admin** (resuelve membresía como
cualquier usuario; sufijo de token al contexto para audit). Dev-headers:
auto-permitido SOLO cuando Supabase no está configurado **y**
`NODE_ENV`-equivalente ≠ producción; fallback a rol `admin` únicamente
cuando NO existe fila `org_members` (paridad exacta con la nota del
CLAUDE.md).
**Acepta:** [ ] service-token sin membresía no es admin · [ ] sufijo en el
contexto · [ ] dev-headers respeta la fila real cuando existe.

### T-072 · Catálogo de permisos + requireRole — P0
**Objetivo:** la primera capa de autorización: rango `viewer < editor <
admin`.
**Espec:** portar el catálogo cerrado de `apps/api/src/permission-catalog.ts`
(41 claves, 20 categorías activas, `defaultRoles` por clave) a un paquete
`internal/authz` con test que ANCLA el conteo exacto (si Node añade una
clave, el test de paridad del catálogo lo delata). `requireRole(min)` como
middleware componible.
**Acepta:** [ ] 41 claves byte-iguales a la fuente · [ ] rango correcto
por rol · [ ] viewer bloqueado de mutaciones (matriz por ruta existente).

### T-073 · requirePermission + registry anotado — P0
**Objetivo:** la segunda capa; cuando una ruta declara ambas, AMBAS pasan.
**Espec:** anotar cada ruta del pilot con `{role?, permission?}` en un
registro central (hoy los mounts son directos — introducir la tabla de
rutas del pilot con dispatcher first-match, paridad con el patrón
Open/Closed de Node). El orden de verificación es `requireRole` → 
`requirePermission`, como el dispatcher de la referencia.
**Acepta:** [ ] toda ruta existente anotada (tabla en el código, no
dispersa) · [ ] denegaciones con código/forma Node · [ ] test recorriendo
el registro y verificando que ninguna mutación quedó sin permiso.

### T-074 · Roles custom por org — P1
**Objetivo:** `org_roles` con la semántica exacta: built-ins virtuales
hasta ser sobreescritos.
**Espec:** `(orgId, name)` único, `inheritsFrom` enum cerrado,
`grantedPermissions` JSONB anulable; `getMemberRole` consciente de
custom (rol no built-in → consultar `org_roles`; default `viewer`,
**fail-closed** si la fila no existe).
**Acepta:** [ ] custom hereda rango del inheritsFrom · [ ] rol desconocido
sin fila → viewer efectivo (fail-closed probado) · [ ] permisos otorgados
se suman a los heredados.

### T-075 · Guard anti-lockout — P1
**Objetivo:** un admin no puede quitarse a sí mismo la capacidad de
administrar permisos.
**Espec:** `mandatoryAdminPermissions()` fuerza `org.permissions.write` +
`members.write` en todo override del rol admin built-in, registrando la
coerción en `metadata.coerced` del audit; los custom con
`inheritsFrom: "admin"` NO se coercen (el caso `billing-admin`).
**Acepta:** [ ] override de admin sin las claves → se fuerzan + audit ·
[ ] custom admin-heredado queda intacto.

### T-076 · Rutas members — P1
**Objetivo:** invite / cambio de rol / expulsión con las semánticas de
cascada de la referencia.
**Espec:** `POST /members/invite`, `POST /members/role`, `DELETE /members`
aceptando nombres custom vía fallback `getOrgRole` cuando `isRole` falla;
member-delete borra SOLO la fila (workflows/runs/audit quedan — audit es
append-only); toda mutación con `withAuditTx` (depende de T-080).
**Acepta:** [ ] invite con rol custom válido · [ ] delete no cascada
(filas hijas intactas, probado) · [ ] la sesión del expulsado muere en el
siguiente request.

### T-077 · Overrides + CRUD de roles — P1
**Objetivo:** la superficie admin de permisos completa.
**Espec:** set/clear de overrides por rol; crear/actualizar/eliminar rol
custom; DELETE de un custom con miembros → 409 `{membersAffected,
code:"role_in_use"}`; DELETE sobre nombre built-in → revierte el override.
Acciones de audit: `org.permissions.override_set/_cleared`,
`org.role.created/_updated/_deleted` (catálogo T-079).
**Acepta:** [ ] escalera 409 exacta · [ ] revert de built-in probado ·
[ ] audit por cada acción con metadata correcta.

### T-078 · Gate de arranque en producción — P0
**Objetivo:** el binario rehúsa arrancar mal configurado.
**Espec:** modo producción (env explícita del pilot, p. ej.
`JANUSLY_GO_ENV=production`) sin Supabase configurado → exit no-cero con
mensaje claro, salvo `ALLOW_DEV_AUTH_HEADERS=true` explícito (paridad con
la regla Node). Documentar en RUNBOOK.
**Acepta:** [ ] arranque rehusado probado (proceso hijo en test) · [ ]
override explícito funciona · [ ] RUNBOOK actualizado.

### T-079 · Chokepoint de audit — P0
**Objetivo:** el catálogo tipado: una acción con typo es error de compilación.
**Espec:** `internal/audit`: tipo `Action` cerrado (constantes generadas
del catálogo Node — extraer la lista de `AuditAction` y fijarla con un test),
`auditAction(auth, action, opts{targetType, targetId, metadata})` que
deriva `source` + bloque `actor{userId, mode, serviceTokenSuffix}`;
metadata SIEMPRE pasa por `safePersistPayload` (T-083; hasta entonces por
el redactor actual).
**Acepta:** [ ] catálogo anclado con test contra la fuente · [ ] forma de fila
byte-comparable con una de Node (fixture) · [ ] fallo del insert de audit
en camino no-tx NUNCA rompe la operación (best-effort documentado).

### T-080 · withAuditTx — P0
**Objetivo:** el invariante: entidad + audit comprometen o revierten juntas.
**Espec:** `WithAuditTx(ctx, pool, func(tx, audit) error)` — el handler
recibe el tx y un `audit` ligado al tx (convención de sombreado de nombre
de la referencia, aquí impuesta por firma). Consumidores iniciales: todas
las rutas de T-076/T-077.
**Acepta:** [ ] fallo inyectado tras el insert de entidad revierte TAMBIÉN
el audit (y viceversa) · [ ] test de atomicidad con wrapTx.

### T-081 · Retrofit de audit — P0
**Objetivo:** saldar la divergencia transversal «sin audit rows» de las
olas 1-2.
**Espec:** añadir audit a: workflows.save/rollback/delete/restore,
run cancel, dlq redrive + replay, campañas (created/cancelled/completed —
la completed desde la bomba con actor sistema), trigger ingest
(trigger.event.received/started/buffered), org config PUT, MCP writes
(source "mcp"). Acciones con los NOMBRES del catálogo Node donde existan;
las pilot-propias (p. ej. `runs.redrive_in_place`) documentadas en §9.
**Acepta:** [ ] cada mutación listada emite exactamente una fila · [ ]
matriz de test por acción · [ ] metadata redactada (secreto plantado no
sobrevive).

### T-082 · GET /audit — P1
**Objetivo:** la lectura admin.
**Espec:** `?action=&cursor=&limit=` — filtro por PREFIJO de acción,
keyset `(createdAt,id)` DESC (cursor `<iso>|<id>` reutilizando el parser),
cap 200; rol admin. Web: panel de Access debe listar contra Go.
**Acepta:** [ ] prefijo filtra en SQL · [ ] round-trip de cursor sin
saltos (mismo patrón del test T-058) · [ ] smoke del panel si el tab
carga con dev-headers.

### T-083 · safePersistPayload formal — P1
**Objetivo:** el chokepoint de persistencia jsonb con TODAS sus capas.
**Espec:** portar `packages/shared/src/safe-persist.ts`: redacción por
VALOR (lista de valores resueltos), redacción por CLAVE (reutilizar
`grammar.IsSensitiveKey` — no bifurcar), cota de bytes (default 256KB,
env `JANUSLY_PERSIST_MAX_BYTES`, por-llamada) con centinela
`{__truncated, originalBytes, maxBytes, preview}`. Migrar los escritores
existentes (state_json, error_json, event payload, audit metadata, DLQ —
workflow/node JSON con bytes infinitos pero clave-redactados).
**Acepta:** [ ] paridad de centinela byte-igual · [ ] DLQ conserva el job
exacto redactado · [ ] property test: ninguna clave sensible sobrevive en
ninguna columna jsonb tras una corrida sembrada con secretos.

### T-084 · Rate limiter en Postgres — P0
**Objetivo:** la decisión de arquitectura ejecutada: limiter sin Redis,
coherente con un-binario-una-base.
**Espec:** ventana fija por `(name, orgId)` sobre una tabla `go_pilot_rate_windows`
(UPSERT contador con expiración por ventana; O(1) por request, sin
vacuum-storm — ventana en la PK). **Fail-open** con warn si la base
falla la operación de limiter (nunca fail-closed). Hooks
`onError/onRecovery` → tracker en memoria + audit one-shot
`rate_limit.degraded`/`rate_limit.recovered` por (bucket, día-UTC) con
dedupe en base (paridad con la semántica Node, sustrato distinto — §9).
**Acepta:** [ ] 429 con la forma Node (`Rate limit exceeded for <bucket>.
Retry in Ns.`) · [ ] fail-open probado matando la conexión del limiter ·
[ ] degradación audita UNA vez por bucket/día bajo réplicas (test con dos
procesos).

### T-085 · Limiter cableado — P1
**Objetivo:** los tres consumidores de la referencia.
**Espec:** (1) buckets API por ruta sensible (start, save, resume — los
que Node limita; leer sus nombres de bucket exactos), (2) storm-guard por
trigger (`rateLimitPerMin` del config del nodo, default 60, máx 10000) →
evento `skipped` + 429 `{ok:false, skipped:true, reason:"rate_limited"}`
(cierra la divergencia de T-040), (3) MCP writes 60/min por org.
**Acepta:** [ ] trigger sobre el límite marca la fila skipped · [ ]
MCP write denegado a 61 · [ ] nombres de bucket byte-iguales.

### T-086 · Catálogo completo de org config — P0
**Objetivo:** el catálogo cerrado con sus guards.
**Espec:** portar `ORG_CONFIG_DEFINITIONS` completo (claves, tipos,
defaults, envKeys, min/max, allowedValues, categorías) + los guards de
nombre/valor prohibidos (nada con forma de credencial entra). Rutas
GET (lista con defaults resueltos por capa) + PUT (validación por tipo y
rango, audit). El snapshot tipado reemplaza el lector ad-hoc de T-043.
**Acepta:** [ ] catálogo anclado con test contra la fuente (conteo + claves) ·
[ ] PUT de un valor con forma de secreto → rechazado · [ ] precedencia
fila→env→default probada por capa (reusar el patrón de T-043).

### T-087 · Consumidores del snapshot — P1
**Objetivo:** que el catálogo gobierne de verdad.
**Espec:** `runs.requireSavedWorkflow` en `/start` (403
`runs_adhoc_disabled` con mensaje Node), TTL de human-form (se consume en
ola 4 — dejar el lector), ventanas de retención por org
(`retention.*Days`) alimentando T-088, `mcp.writeConsent` migrado del
lector puntual de T-057 al snapshot.
**Acepta:** [ ] adhoc-disabled byte-igual · [ ] retención por org
respetada · [ ] T-057 sigue verde sobre el nuevo lector.

### T-088 · Retención completa — P1
**Objetivo:** las purgas que faltan, por org y acotadas.
**Espec:** run_events / audit_logs / usage_events con el patrón CTE
atómico del sweep existente, por org con su ventana del catálogo,
lotes con cota (`cappedByMaxBatches` — paridad del shape del resultado),
enumeración de orgs con datos elegibles. Extiende el runner horario.
**Acepta:** [ ] cada tabla purga solo su ventana y su org · [ ] lote
acotado no bloquea (prueba con volumen sembrado) · [ ] métricas/log por
barrido.

### T-089 · Sustrato usage_events — P1
**Objetivo:** la tubería de telemetría lista antes del primer token AI.
**Espec:** tabla compartida `usage_events`; `internal/usage` con
`Recorder` seam process-global (equivalente de `setUsageRecorder`);
forma exacta `metric:"llm.completion"`, quantity=totalTokens, metadata
{provider, model, providerSimulated, input/output/cached tokens,
latencyMs, costUsd, nodeId, mode, aiError}. Fallos del recorder se
capturan y descartan — la telemetría jamás rompe una llamada.
**Acepta:** [ ] fila con la forma exacta desde un recorder de prueba ·
[ ] recorder que lanza no propaga · [ ] listo para consumo en T-101.

### T-090 · /run/usage + costos — P2
**Objetivo:** reemplazar el stub honesto de T-032.
**Espec:** atribución por runId (toda recall/LLM del run reenvía el
runId — regla para ola 4), agregado de Operations: ventana rodante
completa en Postgres, máx 100 grupos proveedor/modelo + fila resto
explícita (nunca sample crudo arbitrario).
**Acepta:** [ ] shape del agregado paridad Node · [ ] resto agregado
correcto con >100 grupos sembrados.

### T-091 · Health de dos niveles — P1
**Objetivo:** separar lo público-seguro de lo admin.
**Espec:** `/health` público: bloque `rateLimiter` sin bucket/clave cruda
+ `queue:{degraded}|null`; `/system/queue` admin (permiso real vía T-073):
waiting/active/oldest-age calculados de `run_nodes` (la cola ES Postgres;
edad desde elegibilidad — el análogo del matiz BullMQ documentado),
snapshot coalescido 5s con timeout duro. Umbral
`JANUSLY_QUEUE_LAG_WARN_SECONDS` (1..86400, default 60).
**Acepta:** [ ] público jamás expone números vivos de cola · [ ] admin
con la forma Node · [ ] chip del web (`RateLimiterStatusChip`) renderiza
contra Go.

### T-092 · Prometheus + OTel Resource — P2
**Objetivo:** que los dashboards existentes no necesiten renombrar.
**Espec:** Resource `service.name="janusly"`, `service.namespace="janusly"`,
`service.instance.id` (env → hostname); gauges de cola con los nombres
Node (`workflow_queue_waiting_jobs`/`_active_jobs` — aunque el sustrato
sea Postgres) + `janusly_rate_limit_degraded_buckets`; bind 127.0.0.1
por defecto, puerto 9464-equivalente por env, arranque tras migraciones y
fallo duro en conflicto de bind.
**Acepta:** [ ] scrape con nombres exactos · [ ] conflicto de bind
aborta el arranque (probado).

### T-093 · Lane HA de dos instancias — P0
**Objetivo:** la afirmación no probada del REPORT-W2, probada.
**Espec:** arnés que levanta DOS engines (procesos o instancias in-test
con pools separados) sobre la misma base y corre: property tests (25 DAGs),
races dirigidos, campañas concurrentes, timers masivos. Invariantes
idénticos (exactly-once cross-instancia — el claim ladder es la garantía).
`make test-ha`.
**Acepta:** [ ] exactly-once con dos instancias (×3 corridas) · [ ]
campañas sin doble despacho · [ ] hallazgos documentados en §9 (si algo
falla, ESE es el resultado valioso).

### T-094 · Seguridad concurrente de bombas — P1
**Objetivo:** cada singleton implícito, o probado seguro concurrente o con
lease.
**Espec:** revisar campaña-pump (SKIP LOCKED — seguro), retención
(idempotente — seguro), timers (conflicto de resume — seguro pero
duplicando trabajo: medir), reaper. Donde el trabajo duplicado importe,
lease con advisory lock try + renovación. Documentar la matriz en el
RUNBOOK.
**Acepta:** [ ] matriz completa singleton→estrategia · [ ] test de dos
bombas simultáneas por cada una · [ ] RUNBOOK con la sección HA.

### T-095 · Soak — P1
**Objetivo:** memoria y goroutines bajo horas, no segundos.
**Espec:** `make soak` (k6 modo sostenido parametrizable, default 1h),
muestreo periódico de RSS/goroutines/conexiones del binario (endpoint
pprof interno ya existe), reporte con veredicto (creció/estable) en
`conformance/perf/`.
**Acepta:** [ ] 1h sin crecimiento monótono de RSS ni fugas de goroutines
· [ ] reporte generado con la tabla direccional.

### T-096 · Contrato v1 generado — P1
**Objetivo:** el OpenAPI 3.1 del pilot desde un manifiesto sin efectos.
**Espec:** manifiesto Go de rutas v1 (método, path, shapes de
request/response — puede derivar de structs con tags), generador →
`go/contract/openapi.json` checked-in, guard de deriva en `make ci`
(regenerar y `git diff --quiet`). No importar el server desde el
generador (paridad con la regla V1_CONTRACT_ROUTES).
**Acepta:** [ ] documento generado y committeado · [ ] deriva rompe ci ·
[ ] envelope v1 documentado una vez y referenciado.

### T-097 · CI GitHub Actions — P2
**Objetivo:** el lane Go en el CI real (consciente de que cada push a la
privada cuesta — el lane monta en los MISMOS triggers existentes, cero
pushes extra).
**Espec:** job `test_go` en `.github/workflows/ci.yml`: Go 1.2x, servicio
Postgres (pgvector), `make migrate`-equivalente (drizzle + SQL del pilot
vía psql), `make ci`. Cache de módulos. NO añadir orquestación Compose al
YAML (regla del repo): el job usa el service container directo.
**Acepta:** [ ] verde en un push de prueba (coordinado con el batch de
push del usuario) · [ ] duración < 10 min con cache caliente.

### T-098 · REPORT-W3 — P0
**Objetivo:** cierre con la misma vara: qué es ahora la plataforma, matriz
de authz, deuda restante, números del soak/HA, recomendación de ola 4.
**Acepta:** [ ] informe + JOURNAL + §9 al día · [ ] tabla de estado por
área actualizada.

## 15. Ola 4 — Pipeline AI + agentes + formularios humanos (T-099..T-128)

**Tesis:** todo camino AI degrada a `{mode:"fallback", aiError}` — ese
contrato es sagrado y cada ticket lo prueba. Anthropic-only
(`claude-haiku-4-5`) vía `anthropic-sdk-go`; los evals existentes validan
la paridad por HTTP sin cambios.

### Tabla de seguimiento — ola 4

| # | Ticket | Área | Pri | Estado |
| --- | --- | --- | --- | --- |
| T-099 | LlmClient chokepoint (anthropic-sdk-go) + contrato de fallback sagrado | ai-core | P0 | done |
| T-100 | Config AI del catálogo (provider/model/timeouts/reintentos/promptMaxChars) | ai-core | P0 | done |
| T-101 | Usage desde el chokepoint (tokens+cache+costo, pricing + override env, simulated) | ai-core | P0 | done |
| T-102 | Prompt caching + `ai.maxOutputUnits` por llamada | ai-core | P1 | done |
| T-103 | Gobernanza de costo: checkBudget/gateBudget + audit del bloqueo | ai-core | P1 | done |
| T-104 | Modo free_json: extracción/reparación robusta de JSON del texto libre | ai-core | P0 | done |
| T-105 | `/ai/generate-workflow` (prompt DATA-framed + fallback determinista + evals verdes) | genera | P0 | done |
| T-106 | Best-of-N: candidatos + selección | genera | P1 | done |
| T-107 | Guía de operador `janusly.md` (org/workflow, scrubbed, DATA-framed, acotada) | genera | P2 | done |
| T-108 | Registro PromptOps (prompts versionados) | genera | P2 | done |
| T-109 | `/ai/patch-workflow` (envelopes estructurales + alternativas separadas de evidencia) | genera | P1 | done |
| T-110 | Canal lateral de evidencia AI | genera | P2 | done |
| T-111 | Executor de nodo `ai` (fallback a nivel de nodo, salida estable) | nodos | P0 | done |
| T-112 | Sustrato de memoria: pgvector + embeddings (Ollama) + consent de dos flags | memoria | P0 | done |
| T-113 | Tools `vector.search` / `vector.upsert` (kind workflow_vector, consent, write-side) | memoria | P1 | done |
| T-114 | Agent loop con planner determinista de reglas + presupuesto de pasos | agente | P0 | done |
| T-115 | Planner LLM (plan interpretado con reintento, fallback al de reglas) | agente | P0 | done |
| T-116 | Memoria episódica del agente (recall DATA-framed + write-back skip en dryRun) | agente | P1 | done |
| T-117 | `multi_agent` secuencial (previousAgents por agente completado) + paralelo | agente | P1 | done |
| T-118 | Resúmenes operacionales `agent.reasoning` (acotados, estables) | agente | P2 | done |
| T-119 | Scopes diferidos en validación: previousAgents/item con la política estricta | agente | P2 | done |
| T-120 | Nodo `mcp_tool` (cliente): stdio + transportes URL SSRF-validados/pinned | mcp-cli | P1 | done |
| T-121 | Descubrimiento MCP + descriptores + sanitización NFKC para awareness AI | mcp-cli | P1 | done |
| T-122 | writeSide de descriptores + interacción con readiness/approval | mcp-cli | P2 | done |
| T-123 | Matriz de fallos AI (5-10 casos por superficie: timeout/auth/JSON roto/budget) | calidad | P0 | done |
| T-124 | Evals contra Go (`JANUSLY_EVALS_API_URL`) con gate vs baseline; deltas documentados | calidad | P0 | done |
| T-125 | `/validate` + listPlannerTools paridad (proyección planner privada) | calidad | P2 | done |
| T-126 | Nodo `human_form`: tokens HMAC (org/run/node/purpose + TTL) + /resume con schema | humano | P0 | done |
| T-127 | Smokes web: AI Studio generar→guardar→correr (camino fallback $0) + human form | humano | P1 | done |
| T-128 | Informe de ola 4 (REPORT-W4.md) | cierre | P0 | done |

### Cards — ola 4

### T-099 · LlmClient chokepoint — P0
**Objetivo:** UNA puerta para todo token: `internal/ai.Client.GenerateText`.
**Espec:** `anthropic-sdk-go` envuelto en try/catch-equivalente TOTAL: 
cualquier error del SDK → `{mode:"fallback", aiError:<clasificado>}`,
jamás un panic ni un error crudo al caller. Neutral de proveedor en la
interfaz (aunque la postura sea Anthropic-only). Nada fuera de
`internal/ai` llama al SDK (regla de import verificable con un test de
paquete).
**Acepta:** [ ] matriz de errores del SDK → fallback (red, 401, 429,
overloaded, timeout) · [ ] test de que ningún otro paquete importa el SDK.

### T-100 · Config AI — P0
**Espec:** consumir del catálogo (T-086): `ai.provider`,
`ai.anthropic.model` (default `claude-haiku-4-5-20251001`), `ai.timeoutMs`,
`ai.maxRetries`, `ai.promptMaxChars`, `ai.rateLimitPerMin` (bucket del
limiter). Prompt sobre el máximo → truncado documentado, no error.
**Acepta:** [ ] overrides por org efectivos · [ ] sin clave API → todo
camino cae a fallback limpio y los evals `requiresMode:"ai"` se saltan
(paridad con la regla de $0).

### T-101 · Usage desde el chokepoint — P0
**Espec:** una fila `usage_events` por llamada vía el Recorder de T-089:
tokens (input/output/cached/cacheCreation con fallback defensivo a la
metadata de Anthropic), `costUsd` de la tabla de precios portada
(`pricing.ts` + `JANUSLY_LLM_PRICE_<MODEL>`; modelo desconocido → null),
`providerSimulated` solo tras el doble gate del simulador local y siempre
costo cero.
**Acepta:** [ ] fila exacta comparada con una de Node (fixture) · [ ]
modelo desconocido no inventa costo.

### T-102 · Caching + maxOutputUnits — P1
**Espec:** bloques cacheables marcados (system/prompt estable primero),
`ai.maxOutputUnits` per-call → max_tokens; conteos de cache a usage.
**Acepta:** [ ] segunda llamada idéntica reporta cachedInputTokens>0
(test vivo opcional con clave; unit con SDK falso siempre).

### T-103 · Presupuesto — P1
**Espec:** `checkBudget`/`gateBudget` sobre el agregado de usage del mes
por org (límite del catálogo); bloqueo → fallback con
`aiError:"budget_blocked"` + audit del gate (actor sistema); superficie
`/health`-adjacente para el banner del web.
**Acepta:** [ ] gate bloquea exactamente al cruzar · [ ] la llamada
bloqueada NO toca el SDK · [ ] audit una vez por transición.

### T-104 · free_json — P0
**Espec:** portar la extracción del modo por defecto: fences, prosa
alrededor, JSON truncado reparable, arrays top-level, BOM/unicode. Es LA
pieza de fiabilidad medida (memoria del proyecto: free-JSON ganó a
constrained) — suite de fixtures portada de los tests Node + los casos
del harness de experimentos.
**Acepta:** [ ] suite de extracción ≥ paridad de casos Node · [ ]
falla de extracción → fallback, nunca excepción.

### T-105 · /ai/generate-workflow — P0
**Espec:** ensamblaje del prompt (DATA-framing de todo lo user-supplied,
few-shot exemplars portados, guía janusly.md cuando exista T-107),
generación free_json → validación con el validador REAL del dominio →
reparación de un paso si aplica (leer el flujo exacto de Node) →
respuesta con la forma del wire (incluye `mode`). El generador
determinista de fallback (sin clave) portado con paridad de shapes —
los evals deterministas son fallos duros si divergen.
**Acepta:** [ ] `pnpm evals` con `JANUSLY_EVALS_API_URL` apuntando a Go:
deterministas 100%, ai-mode ≥ baseline cuando hay clave · [ ] flat-object
inputs con defaults (subset AI del grammar de inputs) respetado.

### T-106 · Best-of-N — P1
**Espec:** `ai.generationCandidates` del catálogo; N candidatos
concurrentes acotados, selección por el criterio de Node (leer su
scorer), empates estables.
**Acepta:** [ ] N=1 es byte-igual al camino simple · [ ] candidato
inválido no descarta la generación si otro valida.

### T-107 · janusly.md — P2
**Espec:** guía por org y por workflow, acotada en bytes, scrubbed
(`ScrubSecretShapes`) y SIEMPRE DATA-framed (jamás override de política ni
almacén de secretos); inyección solo donde Node la inyecta.
**Acepta:** [ ] intento de instrucción maliciosa queda enmarcado como
datos (fixture del test Node) · [ ] cota de bytes.

### T-108 · PromptOps — P2
**Espec:** registro versionado de prompts con la mecánica de Node
(id+versión activa, lectura en caliente); las superficies leen del
registro, no de literales.
**Acepta:** [ ] cambiar la versión activa cambia el prompt sin redeploy ·
[ ] fallback al literal embebido si el registro falta.

### T-109 · /ai/patch-workflow — P1
**Espec:** el AI-patch del Recovery dialog: config por tipo + envelopes
estructurales del patch (grammar exacta de parche), 0-2 alternativas
consideradas scrubbed SEPARADAS de la evidencia determinista; validación
del resultado con el validador real antes de responder.
**Acepta:** [ ] patch inválido jamás llega al wire · [ ] alternativas
nunca contaminan el bloque de evidencia · [ ] fallback determinista con
forma completa.

### T-110 · Evidencia AI — P2
**Espec:** el canal lateral de evidencia (qué vio el modelo) persistido
acotado y scrubbed, consultable por run/decisión.
**Acepta:** [ ] cotas + scrub probados · [ ] shape paridad.

### T-111 · Nodo `ai` — P0
**Espec:** executor: prompt del config renderizado (plantillas ya
resueltas por el dispatcher), llamada vía chokepoint, salida
`{text|json, mode, aiError?}` estable; fallo del proveedor NO falla el
nodo si el fallback contract dice degradar (leer la semántica exacta del
executor Node — el nodo completa con mode:"fallback").
**Acepta:** [ ] fixture de paridad F-AI (con simulador o fallback
determinista) · [ ] dryRun no llama al SDK.

### T-112 · Memoria pgvector — P0
**Espec:** `memory_entries` compartida; cliente de embeddings (Ollama
`bge-m3`, 1024-dim, base URL del env); `recallMemory`/`commitMemory` con
el consent de dos flags (`JANUSLY_MEMORY_ENABLED` + `org.memory.enabled` +
kind permitido); usage rows `memory.commit`/`memory.recall` con runId
reenviado; recall/commit JAMÁS lanzan (degradan en silencio).
**Acepta:** [ ] consent apagado = byte-igual a hoy · [ ] Ollama caído no
rompe ningún camino · [ ] atribución de runId en /run/usage.

### T-113 · Tools vector — P1
**Espec:** wrappers finos sobre el sustrato (NUNCA re-implementar acceso),
kind `workflow_vector`, upsert write-side (skip en validación), consent
off → `{ok:false, error:"memory_disabled"}` / search vacío sin lanzar.
**Acepta:** [ ] matriz de consent · [ ] write-side respetado en dry-run.

### T-114 · Agent loop (reglas) — P0
**Espec:** el bucle: plan → tool → observación → siguiente, con
presupuesto de pasos, `availableTools` SIEMPRE de `listPlannerTools()`
(catálogo + tipos derivados), dryRun retira los write-side ANTES del
prompt (y el skip del executor queda como defensa en profundidad).
Planner determinista de reglas portado como default sin clave.
**Acepta:** [ ] paridad del planner de reglas sobre los fixtures Node ·
[ ] presupuesto corta limpio · [ ] dry-run jamás ejecuta un write.

### T-115 · Planner LLM — P0
**Espec:** plan generado free_json, validado contra el catálogo de tools
(nombre+input), malformado → reintento acotado → fallback al planner de
reglas; solo un plan AI interpretado con recall no-vacío emite
`agent.memory.recalled` (T-116).
**Acepta:** [ ] matriz: sin cliente / budget-blocked / malformado /
lanzado → fallback de reglas sin evento · [ ] plan válido ejecuta.

### T-116 · Memoria episódica — P1
**Espec:** kind `agent_episode`; al completar, UN episodio (goal +
outcome); el planner LLM recalla semánticamente (query=goal) e inyecta
DATA-framed con cláusula de escape + scrub; write-back skip con
`ctx.dryRun`; evento con conteo + fingerprints SHA-256 de 12 chars, sin
contenido.
**Acepta:** [ ] consent off → cero embeddings llamados · [ ] evento solo
en el camino exacto · [ ] fingerprints estables.

### T-117 · multi_agent — P1
**Espec:** secuencial: `previousAgents` liga POR agente completado (scope
diferido del dispatcher — extender DeferredRoots); paralelo: NUNCA
diferir previousAgents (regla explícita del CLAUDE.md). Salida agregada
con la forma Node.
**Acepta:** [ ] fixture de paridad secuencial y paralela · [ ] binding
tardío probado con política estricta (T-119).

### T-118 · agent.reasoning — P2
**Espec:** resúmenes operacionales acotados y estables (no
chain-of-thought oculto) como eventos del run.
**Acepta:** [ ] cota de bytes · [ ] presentes en el timeline del web.

### T-119 · Scopes diferidos + estricta — P2
**Espec:** unificar la maquinaria: `item`/`index` (existe) +
`previousAgents` con el MISMO contrato de evidencia
`template.unresolved_path` + fallo bajo strict en el punto real de
binding.
**Acepta:** [ ] estricta falla en el binding del scope diferido, no antes
· [ ] evidencia deduplicada acotada.

### T-120 · Nodo mcp_tool (cliente) — P1
**Espec:** conexiones `mcp_tool` stdio (comando/env/cwd/lifetime/stderr
acotados — leer las defensas exactas) y transportes `sse`/`http` con
validación SSRF ANTES de construir y el adaptador DNS-pinned que preserva
respuesta en cada fetch/redirect del SDK (puente al `http-policy` del
pilot). El triplete create+discovery+audit NO va en una tx (red bajo tx,
prohibido).
**Acepta:** [ ] matriz SSRF del transporte URL (privado, rebinding) ·
[ ] stdio con límites de vida/stderr probados · [ ] llamada real a un
server MCP de prueba (el propio server del pilot sirve de fixture).

### T-121 · Descubrimiento + descriptores — P1
**Espec:** tabla de descriptores por conexión; sanitización para prompts:
NFKC + strip del bloque de inyección unicode + control chars + scrub +
cap 300 (portar `sanitizeMcpToolDescription`/`sanitizeMcpPromptLabel` —
ya hay mitad del trabajo en el paquete signature); cap total de prosa
20KB por org.
**Acepta:** [ ] fixtures de inyección del test Node pasan · [ ] caps.

### T-122 · writeSide de descriptores — P2
**Espec:** default `writeSide:true` (fail-safe), admins marcan read-only;
readiness ya trata mcp_tool como sensible — conectar el descriptor real
donde el runtime lo conoce; consent MCP-server (T-057) intacto.
**Acepta:** [ ] tool marcada read-only entra al prompt en dry-run · [ ]
default write-side detrás del gate de approval en readiness.

### T-123 · Matriz de fallos AI — P0
**Espec:** por superficie (generate, patch, nodo ai, agent, embeddings):
5-10 casos de la matriz estándar (timeout, 401, 429, JSON roto, truncado,
budget, tool-input inválido, prompt sobre cota, unicode hostil) con
fixtures compartidos en un catálogo único (regla de la memoria del
proyecto: el catálogo alimenta tests y seeder).
**Acepta:** [ ] catálogo único consumido por ≥3 suites · [ ] cada
superficie degrada al fallback documentado en cada caso.

### T-124 · Evals contra Go — P0
**Espec:** correr `pnpm evals` (harness existente) contra el binario;
gate `summarizeAi`/`compareToBaseline` intacto; deltas → §9 con causa
raíz. Local/dev-invocado, NUNCA CI (regla de créditos).
**Acepta:** [ ] deterministas 100% · [ ] ai-rate dentro del gate o
divergencia explicada y aceptada explícitamente.

### T-125 · /validate + planner tools — P2
**Espec:** `POST /validate` con la forma Node (issues de trigger config
vía los schemas compartidos ya portados); `listPlannerTools()` con la
proyección privada (JSON Schema planner-only NO sale por `/tools`).
**Acepta:** [ ] /validate paridad de códigos · [ ] /tools no filtra el
schema planner.

### T-126 · human_form — P0
**Espec:** portar `packages/engine/src/secrets.ts` (HMAC): token ligado a
org/run/node/purpose con `issuedAt`+`expiresAt` firmados;
`JANUSLY_RESUME_TOKEN_SECRET` dedicado (fallback dev local, prohibido
reusar el service token); TTL del catálogo
(`runs.humanFormResumeTtlSeconds` 300..604800, default 7d) solo para
tokens NUEVOS; legado v1 sin expiresAt → frontera fija de 7 días del
verificador. `/resume` del formulario: valida token + input contra el
subset JSON-schema del nodo y completa SOLO un nodo aún `waiting`
(replays no doble-escriben ni doble-encolan — misma garantía CAS del
resume actual).
**Acepta:** [ ] matriz de tokens (expirado, purpose cruzado, run ajeno,
v1 legado) · [ ] input inválido → 400 con las formas Node · [ ] replay
del token no duplica downstream (test de carrera).

### T-127 · Smokes web ola 4 — P1
**Espec:** AI Studio: generar (camino fallback determinista, $0) →
guardar → correr → verde, contra Go; human form: link de resume → formulario
→ enviar → run continúa. Extiende el spec guardado del pilot.
**Acepta:** [ ] ambos smokes verdes en `run-web-smoke` · [ ] cero
pageerrors.

### T-128 · REPORT-W4 — P0
**Acepta:** [ ] informe con: paridad de evals (tabla), costo real de la
ola en tokens, divergencias vivas de AI, recomendación ola 5.

## 16. Ola 5 — Recovery avanzado + rollouts (T-129..T-158)

**Tesis:** la maquinaria más densa de la referencia. Orden interno: primero
el sustrato durable (cases, receipts, impacto), luego las políticas
(contratos, autonomía, breaker), luego las superficies (playbooks, drills,
read-models del web experto), y rollouts al final porque consume receipts.
Regla: **ningún juez LLM otorga autoridad de mutación** — se hereda tal
cual.

### Tabla de seguimiento — ola 5

| # | Ticket | Área | Pri | Estado |
| --- | --- | --- | --- | --- |
| T-129 | `recovery_cases` durable + receipts de transición append-only (atómicos) | sustrato | P0 | done |
| T-130 | Contratos versionados V1/V2 (detectores expresión/schema V2, fixtures acotadas) | política | P0 | done |
| T-131 | Autonomía: techo por workflow + overrides por fallo → perfil Level 0-4 (puro) | política | P0 | done |
| T-132 | Acciones observe/quarantine + validación de dominancia de efectos | política | P1 | done |
| T-133 | Sandbox replay: `replayMode="validation"` + skip write-side + evidencia estática | sandbox | P0 | done |
| T-134 | `/dlq/validate-fix` (la puerta de sandbox del Recovery dialog) | sandbox | P1 | done |
| T-135 | Linaje de replay Node-parity: run de continuación + `parentLinkKind` (reconciliar revive-in-place) | sustrato | P0 | done |
| T-136 | Impacto terminal ligado a generación: claim token → CAS → impact_events + rollups O(1) | impacto | P0 | done |
| T-137 | Atribución atómica incidente/playbook; iniciación jamás cuenta como win (reconciliar T-055) | impacto | P1 | done |
| T-138 | Circuit breaker: decisión pura + pausa CAS + resume manual + backfill oldest-first de buffered | breaker | P0 | done |
| T-139 | Playbooks: draft/activate/retire, match exacto workflow+firma, sandbox fresco, auto-retire | playbook | P1 | done |
| T-140 | Drills medidos + dossier de validación por org + exports | drills | P2 | done |
| T-141 | Feedback loop + calibración de confianza (ajuste diario, toggle por org) | feedback | P2 | done |
| T-142 | Ownership + handoff de incidentes + estados de escalamiento (drawer) | owner | P1 | done |
| T-143 | `/dlq/queue` read-model (severidad, sort, owner, search, day, keyset propio) | read-model | P0 | done |
| T-144 | `/dlq/cluster-members` + `cluster-apply` + `bulk-replay` + `resolve`/`bulk-resolve` | read-model | P1 | done |
| T-145 | Read-models de recovery-home (clusters con recurrencia REAL post-recovery) | read-model | P1 | done |
| T-146 | Alerting: `alert_policies` + evaluación + notificación por el chokepoint de tools | alertas | P2 | done |
| T-147 | Run-explain + exports de evidencia (reports subset) | reports | P2 | done |
| T-148 | Latencia de primera acción set-once + recurrencia a 7 días ligada a impacto | métricas | P2 | done |
| T-149 | Rollouts: esquema + asignación determinista capturada en runs/eventos | rollout | P0 | done |
| T-150 | Compatibilidad estricta de triggers externos + version-write locking | rollout | P1 | done |
| T-151 | Receipts de calificación por par exacto de versiones | rollout | P1 | done |
| T-152 | Auto-rollback con muestra mínima + receipts terminales idempotentes + repair acotado | rollout | P0 | done |
| T-153 | Validación/replay + pins de subworkflow jamás consumen canary | rollout | P1 | done |
| T-154 | Ingest con asignación de rollout (nodo exacto en la versión asignada) | rollout | P1 | done |
| T-155 | Smokes web expertos: recovery queue + drawer + cluster-apply contra Go | web | P1 | done |
| T-156 | Matriz de fallos de recovery (catálogo compartido, 5-10 por superficie) | calidad | P0 | done |
| T-157 | Fixtures F18-F25 (validation, breaker pause/buffer/resume, playbook, rollout) + goldens | paridad | P0 | done |
| T-158 | Informe de ola 5 (REPORT-W5.md) | cierre | P0 | done |

### Cards — ola 5 (las decisiones no obvias)

### T-129 · recovery_cases + receipts — P0
**Espec:** caso durable por (workflow, firma) con transición append-only
(receipt por cambio de estado, atómico con el cambio vía withAuditTx-style
tx). Resolución de operador: replacement (exige Level 3) / accepted-loss
(auditable siempre).
**Acepta:** [ ] transición sin receipt imposible (tx probada) · [ ]
escalera de estados cerrada.

### T-130 · Contratos V1/V2 — P0
**Espec:** V1: detección semántica DESHABILITADA para snapshots
históricos (regla dura). V2: detectores deterministas de outcome por
expresión (la gramática existente) y por schema, fixtures acotadas,
decisiones semánticas same-source usan el detector MÁS estricto.
**Acepta:** [ ] snapshot V1 jamás activa semántica · [ ] mismo-source →
estricto probado con detectores en conflicto.

### T-131 · Autonomía Level 0-4 — P0
**Espec:** módulo puro (domain): techo del workflow + overrides
específicos por fallo → perfil resuelto; Level 4 (auto-apply técnico)
autoriza SOLO en la frontera del claim durable con la gramática exacta de
patch + factores (contrato/evidencia/impacto-previo/blast-radius/rollback/
effect-receipt); el navegador solo RENDERIZA el veredicto del server.
**Acepta:** [ ] tabla de resolución anclada con tests a los casos Node · [ ]
ningún camino LLM muta sin el perfil.

### T-133 · Sandbox replay — P0
**Espec:** `replayMode="validation"` propaga a todo hijo; write-side
nodes/tools se saltan con el clasificador de tool-execution;
`validationEvidenceLevel: "static"`; los replays sandbox NUNCA cuentan
para breaker ni para métricas verified.
**Acepta:** [ ] un write-side sembrado NO ejecuta efecto en validación ·
[ ] exclusiones de breaker/métricas probadas.

### T-135 · Linaje de replay — P0
**Espec:** cerrar la divergencia F05: `/dlq/replay` crea run de
continuación con `parentLinkKind:"replay"` (trace-only: profundidad y
terminal delivery solo por aristas ejecutables), attempts re-armados como
Node; el adapter `/runs/redrive` mantiene revive-in-place como camino
pilot documentado O migra — decidir en el ticket leyendo el uso web, y
actualizar la divergencia aceptada de F05 si se cierra.
**Acepta:** [ ] golden F05 SIN la divergencia de attempts (si se cierra)
· [ ] linaje visible en la proyección del run.

### T-136 · Impacto terminal — P0
**Espec:** el pipeline exacto: claim token en `run_nodes` → CAS al
completar → `recovery_impact_events` idempotente → rollups O(1);
generation-bound (un claim viejo no acredita un run nuevo).
**Acepta:** [ ] doble terminal no duplica impacto (carrera probada) ·
[ ] rollup O(1) verificado por plan.

### T-138 · Circuit breaker — P0
**Espec:** capa de decisión PURA (racha de fallos consecutivos, replays
sandbox excluidos) + pausa CAS sobre `workflows.status` + trip auditado;
la pausa cierra TODOS los puntos de entrada: `/start` (403 con el código
por causa — la fila `reject` de la tabla de pausa), ingest (buffered+202 —
ya existe), scheduler (drop — llega en ola 6, dejar el seam); resume
DELIBERADAMENTE manual `POST /workflows/:id/resume` con backfill
oldest-first de buffered (cierra la divergencia de T-040) y ticks de cron
descartados.
**Acepta:** [ ] racha dispara una sola pausa (CAS) · [ ] backfill drena
en orden con claims (`backfill_claim_token` — las columnas ya existen) ·
[ ] sandbox no cuenta para la racha.

### T-143 · /dlq/queue — P0
**Espec:** el read-model del web experto: envelope {items, nextCursor,
hasMore}, filtros status/severity/sort/owner(`me`)/search(≤100,
ILIKE server-side)/day(UTC), cursor decodificado contra el sort EFECTIVO
(sort distinto → página 1, jamás mal ordenar); severidad del modelo
Node (downtime). Cierra el gap documentado de T-064.
**Acepta:** [ ] panel DLQ del web renderiza y pagina contra Go (smoke
T-155) · [ ] cursor bajo sort cambiado degrada a página 1.

### T-149..T-154 · Rollouts (bloque)
**Espec común:** asignación determinista (hash de la clave de asignación)
CAPTURADA en el run y sus eventos (nunca re-derivada); receipts de
calificación por par exacto (baseline,candidate); rollback automático con
muestra mínima; validación/replay/pins jamás consumen canary; ingest
asigna y resuelve el NODO exacto en la versión asignada (el 409
`trigger_no_matching_node` de "Assigned workflow version no longer
contains the trigger node").
**Acepta (bloque):** [ ] mismo assignment key → misma variante siempre ·
[ ] rollback dispara con la muestra mínima y NUNCA antes · [ ] fixtures
F-rollout con goldens.

### T-157 · Fixtures F18-F25 — P0
**Espec:** validación sandbox (write skip observable), breaker
(racha→pausa→buffer→resume→backfill), playbook (sandbox fresco + apply),
rollout (asignación + rollback), impacto (redrive→terminal→rollup).
Capturas SOLO por el stack aislado.
**Acepta:** [ ] goldens capturados + paridad ×3 · [ ] recaptura completa
byte-idéntica.

## 17. Ola 6 — Integraciones + scheduler + subworkflows + listo-para-cutover (T-159..T-194)

**Tesis:** el resto del catálogo de nodos/tools, el cron sustrato completo,
y la evidencia final para el go/no-go: HA validado, soak largo, seguridad
revisada, y el mapa de cutover por ruta. **Dirección estratégica (Johnny,
2026-07-31): se incluye TODO — SCIM y experiments entran (T-189..T-194).
La convicción es que el futuro del proyecto es Go, no Node: el objetivo ya
no es solo pasar una puerta go/no-go sino dejar la base de código
definitiva para refinar y abandonar Node. Consecuencia: el mapa strangler
de T-184 deja de tener exclusiones permanentes — responde "cuándo migra
cada ruta", nunca "si migra".** Regla: secretos SOLO por
`credentials.secret_ref` — jamás una URL/clave cruda en config u
org_configs (los guards de T-086 lo imponen).

### Tabla de seguimiento — ola 6

| # | Ticket | Área | Pri | Estado |
| --- | --- | --- | --- | --- |
| T-159 | Secret Store: cifrado envelope + root key externa + tabla credentials | secretos | P0 | done |
| T-160 | Rutas de credenciales + rotación (withAuditTx) + resolver async org-aware | secretos | P0 | done |
| T-161 | Readiness con credenciales (`credential_missing`, cap 50 refs) — cierra gap T-042 | secretos | P1 | done |
| T-162 | Chokepoint integration-tools (fetchHttpTarget-only, límite org+credencial, envelope never-throw) | integr | P0 | done |
| T-163 | `email.send` + postura segura de entrega (catálogo email.*, providers noop/simulador) | integr | P1 | done |
| T-164 | `pdf.generate` + object store (driver FS local + seam S3-compatible) | integr | P2 | done |
| T-165 | Acciones Slack firmadas de recovery | integr | P2 | done |
| T-166 | PagerDuty V3: trigger firmado → lectura autoritativa → política (`zoned-window`) → ack → snooze | integr | P1 | done |
| T-167 | `time.window` tool (el ÚNICO primitivo zone-aware; sesgos documentados sin unificar) | integr | P1 | done |
| T-168 | Ingest de email: DKIM + selector de alias + attachments al object store + caps 1MiB | triggers | P1 | done |
| T-169 | Triggers `file_dropped` + `mcp_server_event` (ingest + executors passthrough) | triggers | P2 | done |
| T-170 | Shadow ingestion de runtime externo (firmado/idempotente, secuencia monotónica, sin crédito) | triggers | P2 | done |
| T-171 | Upstream-health (fail-open) + auto-pausa `upstream_degraded` + fila reject de /start | triggers | P1 | done |
| T-172 | Tools `db.schema.describe` + `db.query.read` (credencial postgres, validación SQL completa) | db | P1 | done |
| T-173 | `db.query.write` + `db.query.transaction` (write-side, límite por org+credencial) | db | P1 | done |
| T-174 | `loop` modo for_each (tool por item, ≤1000, conc 1..20, presupuesto único, stop cooperativo) | nodos | P0 | done |
| T-175 | Nodo `subworkflow`: checkpoint del padre en tx + publicación del root del hijo + profundidad | nodos | P0 | done |
| T-176 | Handoff terminal hijo→padre + `parentNotificationAfter` + reconciler con lease + settle de hermanos | nodos | P0 | done |
| T-177 | Nodo `schedule`: `schedule_entries` + sync en save + due-clock + guard de padre activo + drop en pausa | cron | P0 | done |
| T-178 | Crons de sistema restantes: auto-healing supervisado + heatmap de observabilidad + purga de consent | cron | P2 | done |
| T-179 | Reconciler de checkpoints vencidos (paridad del overdue de approvals/timers) — verificación | cron | P2 | done |
| T-180 | Snippets + solution packs + onboarding (rutas + smoke) | producto | P2 | done |
| T-181 | Health rollup de workflows + SLO + `/workflows/health/delta` (same-failure por firma) | producto | P2 | done |
| T-182 | Tags/folders/metadata + distincts excluyendo tombstones + paridad Flows completa | producto | P1 | done |
| T-183 | Barrido final F1-GAPS → cero-o-documentado (byte-paridad de lo que el web toca) | paridad | P0 | done |
| T-184 | Proxy strangler: mapa de cutover por ruta + comparador dual-run (shadow) | cutover | P0 | done |
| T-185 | HA final: suite completa a dos instancias + kill-failover + soak 24h | cutover | P0 | done |
| T-186 | Revisión de seguridad: matriz SSRF re-corrida, scrub e2e, matriz authz por permiso | cutover | P0 | done |
| T-187 | SDK Python contra Go (pytest lane) + runbook de cutover por tenant + REPORT-W6 + plantilla go/no-go | cutover | P0 | done |
| T-189 | `eval_datasets`: CRUD + snapshots inmutables (sustrato de experiments y del gate de evals) | ai | P1 | done |
| T-190 | Experiment harness: runner data-agnóstico + 3 scorers + `POST /experiments/run` recommendation-only | ai | P1 | done |
| T-191 | SCIM 1/4: webhook WorkOS (firma t/v1 fail-closed) + directorios attach/update/revoke + state repos | scim | P1 | done |
| T-192 | SCIM 2/4: dispatcher puro — 3 guardas (replay/out-of-order/resurrección) + 2 guardas de colisión + provision/deprovision con policy de dominios | scim | P0 | done |
| T-193 | SCIM 3/4: grupos — `deriveScimRole` v2 (mayor rango, fallback flat byte-igual) + eventos de membresía + group state | scim | P1 | done |
| T-194 | SCIM 4/4: admin CRUD de mapeos grupo→rol + picker de grupos + bulk re-sync (cap 5000, un audit) + smoke del panel | scim | P1 | done |

### Cards — ola 6 (las decisiones no obvias)

### T-159/T-160 · Secret Store — P0
**Espec:** cifrado envelope (DEK por fila, KEK de env/root key externa),
migración de referencias legacy de env como *referencia deliberada* (no
copia del valor); resolver async org-aware ÚNICO; rotación con
withAuditTx; NUNCA se devuelve valor, nombre de env ni error upstream con
forma de secreto.
**Acepta:** [ ] dump de la base no revela plaintext · [ ] rotación no
rompe referencias en vuelo · [ ] matriz de no-eco.

### T-162 · Chokepoint integration-tools — P0
**Espec:** TODO tool de integración sale por `fetchHttpTarget` (el
executor http del pilot como primitivo — cero SDKs de vendor), límite por
org+credencial, usage events, bit writeSide, envelope never-throw
`{ok:false, error}` (los tools de integración jamás lanzan).
**Acepta:** [ ] test de que ningún tool de integración importa un cliente
HTTP propio · [ ] envelope en cada modo de fallo de la matriz.

### T-166/T-167 · PagerDuty + time.window — P1
**Espec:** compartir `zoned-window` (resolución de zona + cruce de
medianoche) con los DOS sesgos intactos y sin unificar: `time.window`
LANZA ante config malformada (primitivo de decisión), el evaluador de
política PD la absorbe como "working hours" (política rota jamás autoriza
mutación). Flujo V3 firmado → lectura autoritativa → evaluación → ack →
snooze; AI post-acción solo si se pidió.
**Acepta:** [ ] los dos sesgos probados por separado · [ ] firma V3
verificada con fixtures reales.

### T-174 · loop for_each — P0
**Espec:** un tool registrado por item DENTRO del mismo nodo (jamás un
primitivo de cola), ≤1000 items, concurrencia 1..20 (default 4), TODOS
los inputs renderizados antes del primer efecto, UN presupuesto de fallos
(conteo o porcentaje), throws y `{ok:false}` cuentan igual; timeout
write-side o presupuesto excedido → `writeSide=true`, deja de desencolar
cooperativamente y PROHIBIDO el retry de nodo completo (replay bajo control del
operador es más seguro que duplicar efectos externos). Diagnósticos
acotados por item y agregados.
**Acepta:** [ ] render-antes-del-primer-efecto probado · [ ] presupuesto
corta cooperativo · [ ] sin whole-node retry en write-side (test).

### T-175/T-176 · subworkflow — P0
**Espec:** el arranque del hijo comete el checkpoint exacto
`running→waiting` del padre + ambos eventos EN la misma tx ANTES de
publicar el root del hijo; `parentLinkKind` separa `subworkflow`
(ejecutable: profundidad + terminal delivery) de `replay` (trace-only);
todo hijo terminal marca `parentNotificationAfter` (ms) y solo se limpia
tras el handoff exacto + readiness downstream; padre fallido asienta a
TODOS los hermanos en espera antes de que un replay lo reabra (y reabrir
limpia el marcador terminal atómicamente); reconciler con lease para
ventanas de crash. Profundidad del catálogo (`subworkflow.maxDepth`).
**Acepta:** [ ] crash inyectado entre checkpoint y publicación → el
reconciler repara sin duplicar · [ ] validación propaga al hijo · [ ]
fixture de paridad con golden.

### T-177 · schedule — P0
**Espec:** sustrato propio sobre el patrón due-clock YA probado (campañas):
`schedule_entries` sincronizadas en save (`syncWorkflowSchedules` —
upsert/retire por diff), guard de padre activo (un entry huérfano de un
workflow tombstoned JAMÁS dispara — paridad de la regla del scheduler
worker), tick vencido → startRun con input de schedule, pausa → DROP
ruidoso (la fila `drop` de la tabla de pausa — "el run de las 3am no
significa nada a las 6am").
**Acepta:** [ ] save re-sincroniza (añade/retira) · [ ] tombstone no
dispara · [ ] pausa descarta con log/evento, sin backfill.

### T-183 · Barrido F1-GAPS final — P0
**Espec:** recorrer el inventario §11 completo contra el pilot: cada ruta
que el web consume, o byte-paridad verificada, o divergencia §9 con
decisión. Actualizar F1-GAPS.md a estado terminal.
**Acepta:** [ ] cero gaps sin clasificar · [ ] smoke de TODOS los tabs
del web sin pageerrors.

### T-184 · Strangler + shadow — P0
**Espec:** mapa de cutover por ruta (ejemplo Caddy/nginx con el split),
comparador dual-run: mismo request a ambos backends, diff de respuestas
normalizado (ids/timestamps fuera), reporte de divergencia; correr sobre
el tráfico de los smokes y del harness de paridad.
**Acepta:** [ ] comparador reporta cero diffs inesperados sobre la suite
completa · [ ] mapa versionado en el repo.

### T-189/T-190 · Experiments — P1
**Espec:** el runner vive en un paquete data-agnóstico (mismo corte que la
referencia: `ai` sin dep de data); cada ejemplo corre por AMBOS brazos vía
el chokepoint LlmClient (usage events gratis); throws por lado = `aiError`
+ score 0 — NUNCA lanza. Scorers `string_equality` / `json_schema` /
`llm_judge` con degradación determinista a token-overlap (sin cliente,
throw, o reply inparseable). Budget-gate ANTES de correr; bucket "ai".
**Invariante sagrada:** promoción = SOLO recomendación (`summary_json.
recommendation` + audit `experiment.run.promotion_suggested`) — jamás
escribe prompts/org_configs. Es la tesis de la ola 5 aplicada a prompts.
**Acepta:** [ ] $0 end-to-end con simulador + judge degradado · [ ] test
de que la ruta no escribe prompts ni configs · [ ] per-side throw no
tumba el run.

### T-191..T-194 · SCIM directory sync — P0/P1
**Espec:** las 6 tablas YA están en el baseline goose. Firma estilo Stripe
(`t=<ms>,v1=<hex>` HMAC-SHA256 del body CRUDO, fail-closed sin secret,
±5 min, compare constant-time); webhook SIEMPRE 200 en guard-reject
(WorkOS no debe reintentar por horas), 5xx solo en I/O real. Binding de
org por `provider_directory_id` — el ÚNICO read sin scope del módulo;
jamás confiar el tenant del payload. Dispatcher puro con guardas EN ORDEN:
replay → out-of-order → resurrección; colisiones: re-key bloquea CUALQUIER
fila preexistente, create bloquea solo filas invitadas por humanos y
ABSORBE las scim-owned (asimetría deliberada — el re-attach depende de
ella). La fila de dedup se libera SOLO en throw (release throw-only).
Join key `(orgId, lower(email))` — sobrevive el rewrite del SSO.
`deriveScimRole`: mayor rango entre grupos mapeados, sin mapeos =
comportamiento flat byte-igual, custom roles rankean -1. Re-sync: cap
5000 honesto (`capped`), UN audit por barrido, sin `invitedBy` (el actor
original sobrevive). Revoke = HARD delete (el re-attach lo exige por los
índices únicos). Sin WorkOS real en el pilot: fixtures de firma/eventos
como la suite Node.
**Acepta:** [ ] las 3 guardas + 2 colisiones con fixtures por caso · [ ]
matriz de audits (~25 acciones) presente · [ ] re-attach tras revoke ·
[ ] smoke del panel Access contra Go.

### T-187 · Cierre y go/no-go — P0
**Espec:** SDK Python (pytest apuntando a Go — mismo wire); runbook de
cutover por tenant (switch, monitoreo, rollback = apuntar el proxy de
vuelta); REPORT-W6 con la plantilla de decisión: evidencia por área,
riesgos residuales, criterio explícito de go/no-go.
**Acepta:** [ ] pytest verde contra Go · [ ] plantilla lista para la
decisión del timebox.

### Dependencias entre olas (para reordenar con criterio si hace falta)

- T-081 (retrofit audit) depende de T-079/T-080; **todo ticket posterior a
  T-079 que cree una mutación incluye su audit en el mismo commit**.
- T-085 y T-100 dependen del limiter (T-084); T-101/103 de usage (T-089).
- T-105 depende de T-099/T-104; T-115/116 de T-112; T-126 del catálogo
  (T-086, TTL).
- T-134/139/140 dependen de T-133; T-137/148 de T-136; T-152 de T-151;
  T-154 de T-149 y del ingest existente.
- T-161 cierra el gap de readiness de T-042 y depende de T-159/160;
  T-166 depende de T-162; T-176 depende de T-175; T-177 usa el patrón de
  T-045.
- T-183..T-187 son terminales: exigen TODO lo anterior verde.

## 18. Ola 7 — Endurecimiento post-go/no-go: arquitectura, performance, cero-leaks, fases 4-5 y tests adversariales (T-500..T-535)

Origen: backlog de mejora levantado 2026-08-01 tras el cierre de la ola 6
(REPORT-W6 = GO). Numeración: la serie T-500 evita la colisión con la
tabla de fases (T-201..T-400). Mismo protocolo por-ticket de siempre:
partial → implementar → tests integration + `make lint` 0 ANTES de
commit → done + fila §9 + JOURNAL + commit local, resumen en español.
Prioridades: P0 = destraba cutover o confiabilidad; P1 = valor directo;
P2 = oportunista.

### Tabla de la ola

| Ticket | Título | Tema | Prio | Estado |
| --- | --- | --- | --- | --- |
| T-500 | Version-id real en `/start` de guardados (mata la convención `workflow_version_id = workflowId`) | arquitectura | P0 | done |
| T-501 | Partir `v1.go` (1,304 líneas) en módulos: mounts / runs / workflows / encoding | arquitectura | P1 | todo |
| T-502 | Partir `scim.go` (1,354 líneas): verificador / dispatcher / rutas | arquitectura | P1 | todo |
| T-503 | Partir `queries.sql` (2,584 líneas) por contexto acotado (sqlc multi-archivo) | arquitectura | P1 | todo |
| T-504 | Wiring OTel de trazas + poblar `runs.traceId` (cierra divergencia anotada) | arquitectura | P1 | todo |
| T-505 | Alinear granularidad del event-stream (`node.queued`/`node.started` por nodo, paridad 9-eventos) | arquitectura | P0 | done |
| T-506 | LISTEN/NOTIFY como despertador primario del dispatcher (poll = fallback) | performance | P1 | todo |
| T-507 | Barrido EXPLAIN de las ~120 queries de la ola 6 + índices faltantes (patrón two-file) | performance | P1 | todo |
| T-508 | Perfil de allocs (pprof heap bajo bench) + optimizaciones dirigidas de `safePersist` | performance | P1 | todo |
| T-509 | Batch de escrituras de `run_events` en la tx de completion | performance | P2 | todo |
| T-510 | Fix cardinalidad de k6-soak (`name` tag) + re-corrida del soak 24h confiable | performance | P0 | partial |
| T-511 | `goleak` en engine/httpapi + test de fuga de conexiones Postgres como gate | recursos | P0 | done |
| T-512 | `runner.Group` para los sweeps de `cmd/api`: shutdown ordenado + panic-recovery por sweep | recursos | P1 | done |
| T-513 | Tope GLOBAL de proceso para pools externos de db-tools (hoy solo 5/org) | recursos | P1 | todo |
| T-514 | Superficies AI restantes: `/ai/explain-run`, `/ai/explain-workflow`, `/ai/review-workflow`, `/ai/suggest-improvement`, `/ai/health` | funcionalidad | P1 | todo |
| T-515 | Auto-healing con propuestas LLM detrás del budget gate (hoy solo `harden_retries` determinista) | funcionalidad | P1 | todo |
| T-516 | Billing: `/billing/budget`, `/billing/usage`, `GET/POST /workflows/{id}/budget` | funcionalidad | P1 | todo |
| T-517 | Replay-lab: `POST /runs/replay-lab` + `/fork` | funcionalidad | P1 | todo |
| T-518 | Recovery V2 reads: `/recovery/cases`, `/recovery/ledger`, `/recovery/my-wins` | funcionalidad | P1 | todo |
| T-519 | Identidad restante: `GET /organizations`, `POST /users/me`, aceptación de invitación por página, `/plugins/install` | funcionalidad | P2 | todo |
| T-520 | `POST /causal` (panel de razonamiento causal, sin LLM — siempre disponible) | funcionalidad | P2 | todo |
| T-521 | Follow-ups P2 de T-164: driver S3 SigV4 real del object store + dialect HTML de `pdf.generate` | funcionalidad | P2 | todo |
| T-522 | (T-104) `embed.FS` con el dist del web — un solo binario desplegable | funcionalidad | P2 | todo |
| T-523 | `ARCHITECTURE.md`: 4 diagramas mermaid (ciclo de vida del run, secuencia subworkflow, mapa de módulos, ladder de claims) + ADRs cortos | docs | P1 | todo |
| T-524 | Bookkeeping del PLAN: voltear a done los punteros stale de la tabla de fases (T-201..T-305, T-400 parciales) | docs | P2 | todo |
| T-525 | Helper `route()` con gate obligatorio (mata ~500 líneas de boilerplate de mounts; montar sin gate = error de compilación) | refactor | P1 | todo |
| T-526 | Partir `complete.go` (888 líneas): terminal-failure/DLQ/hook vs readiness/fan-in | refactor | P1 | todo |
| T-527 | Vistas tipadas (structs con tags JSON) para los wires núcleo: runs, dlq, workflows | refactor | P1 | todo |
| T-528 | `internal/webhooksig`: unificar los 5 verificadores de firma entrante (posturas por proveedor) | refactor | P1 | todo |
| T-529 | DX: `make verify` (escalera completa) + `make seed` (org demo con workflows/runs/DLQ/incidentes) | utilidades | P1 | todo |
| T-530 | CLI `janusly-admin`: redrive, resync de schedules, inspección de credenciales (los curls del runbook) | utilidades | P2 | todo |
| T-531 | Caos de Postgres: `run-chaos.mjs` — kill de la base a mitad de completion tx, reconnect de pools, recuperación verificada | tests | P0 | todo |
| T-532 | Cobertura con piso por paquete en `make ci` + unit tests para los 6 paquetes sin tests propios (orgconfig, objectstore, packs, prompts, contract, migrate) | tests | P1 | todo |
| T-533 | Fuzzing de los parsers que comen input externo: cron propio, CloudEvents estricto, escritor PDF | tests | P0 | todo |
| T-534 | Property tests de SCIM: secuencias aleatorias de eventos con timestamps desordenados vs invariantes | tests | P1 | todo |
| T-535 | Bench de fallo parcial: upstream degradado + DLQ creciendo + breaker disparando, lecturas sin degradarse | tests | P1 | todo |

### Evidencia de ejecución (filas §9 de la ola 7)

| Ticket | Evidencia / desviaciones |
| --- | --- |
| T-510 (parcial) | Fix de cardinalidad de k6-soak: tags `name` fijos en los 4 requests (el runId en la URL de /v1/status minteaba una serie por poll — 800k series, k6 ~100MB con riesgo de morir antes de las 24h; ahora O(4) series y k6 plano). Humo de 3m validado sin warnings; el "creció" del heap en ventana de 3m es artefacto de calentamiento (RSS bajó −3.3%) — el arnés está diseñado para ≥1h. Soak de 24h RELANZADO con DB fresca y pools acotados; el ticket cierra cuando el veredicto aterrice en SOAK.md y se anexe a REPORT-W6. |
| T-512 | `internal/boot.Runner`: los 9 loops de fondo de cmd/api (workers, pump de campañas, retention, upstream, reconciler de subworkflows, schedule, auto-healing, purga de memoria, reaper) pasan de `go func` sueltos a arranque NOMBRADO supervisado — pánico en un sweep = recover + log con stack + restart con backoff (1s duplicando hasta 60s, reset tras 10 min limpios) en vez de tumbar el proceso; retorno limpio = terminado, no re-arrancado; `Shutdown()` cancela y ESPERA a todos (drenaje determinista ANTES de cerrar pools — la disciplina que goleak exige en tests aplicada al proceso real). Unit tests de las tres posturas (pánico reinicia, shutdown drena a cero, retorno limpio es final) + failover re-corrido verde bajo el runner (61/61, exactly-once) + suite completa con goleak verde. |
| T-511 | Higiene de goroutines y conexiones como GATE de CI, y pagó al primer arranque: `TestMain` con goleak en engine y httpapi (ambas lanes, unit e integration; keep-alives del http.DefaultTransport se CIERRAN en vez de allowlistearse; allowlist mínima = solo el health-checker de pgxpool con su razón) encontró una fuga real de inmediato — los fixtures servidor MCP del go-sdk dejan vivos los readers jsonrpc2 por-sesión (`streamableServerConn.Read`) después del Close del cliente; drenaje explícito de `server.Sessions()` en los 4 fixtures (engine, mcpclient ×2, httpapi). Gate de conexiones: `TestPostgresConnectionBaseline` — 10 ciclos completos de harness (server + workers + hub + pools) deben devolver `pg_stat_activity` al baseline con tolerancia +2 (la clase del leak LISTEN de T-185, convertida en CI: un hijack por harness = subida de 10 = fallo). Suite completa + lint verdes bajo el gate nuevo. |
| T-505 | Paridad de 9 eventos lograda con la verdad del dump (no del spec): el vocabulario real de Node es `node.running` (no `node.started`) y el noveno evento es `run.status_checked` — el marcador del settle del fan-in que emite cada pasada de enqueue con 0 encolados (runtime.ts:654). Tres emisiones nuevas: `node.queued` por ROOT en la tx de StartRun (offsets de ms para que el keyset (created_at,id) jamás ordene el queued antes de run.started), `node.running` `{attempt}` tras ganar el claim (best-effort pool-level — la postura await-fuera-de-tx del reference: telemetría jamás bloquea ejecución), y `run.status_checked` a causa+2ms tras CUALQUIER settle (terminal o no). El corpus dual: `status-linear`/`run-linear` pierden la divergencia de eventos (queda solo traceId → T-504); streams byte-idénticos re-verificados 27/27. LECCIÓN AMBIENTAL del ticket: el primer bench mostró "regresión" de −93% — también en list, que no se tocó; el A/B con el soak CONGELADO (SIGSTOP preserva sus 24h; pausa ~8 min anotada) demostró que era 100% ruido co-residente: con-cambios 51.9 runs/s p95 260ms vs sin-cambios 44.8/527 en condiciones idénticas. Regla operativa nueva: bench co-residente con soak = inválido; solo A/B adyacente con soak congelado. `TestStartRunCommitsSkeletonAtomically` actualizado a la secuencia nueva con nota. |
| T-500 | El censo reveló trabajo MENOR al especificado: todos los caminos engine-driven YA estampaban fila de versión real (schedule, subworkflow, trigger ingest, backfill del breaker), y los doc-posted (/start, MCP, packs) igualan la convención doc-id DE NODE (verificado en reads.ts). La divergencia real era la SEMÁNTICA DE CONTEO: el pilot contaba con OR generoso donde Node cuenta SOLO runs version-linked (INNER JOIN). Alineados `ListWorkflowRows` + `ListDeletedWorkflowRows` (count + lateral); la atribución de salud intacta (su coalesce ya prefería la fila real — compat histórica de T-181). Comparador: las 2 divergencias de workflow-trash ELIMINADAS — dual 27/27 con trash OK limpio re-verificado. `TestVersionAttributionSemantics` nuevo; `TestWorkflowReadSurfaces` actualizado con nota. |


### Especificaciones

### T-500 · Version-id real en `/start` — P0
**Espec:** al arrancar un workflow GUARDADO sin pin, resolver la fila de
`workflow_versions` más reciente y estampar SU id en
`runs.workflow_version_id` (como Node); los ad-hoc inline conservan la
convención actual (id del doc). Migrar los consumidores de la "versión
efectiva por conteo" (health signals, heatmap, delta, rollouts) a leer el
join directo; conservar compatibilidad de lectura para las filas
históricas (coalesce por convención vieja). Actualizar el corpus dual:
la divergencia anotada de `runCount`/`lastRunStatus` debe DESAPARECER de
la lista esperada.
**Acepta:** [ ] runs de guardados joinean versión real · [ ] health/delta
sin la derivación por conteo · [ ] dual-run: workflow-trash pasa a OK
limpio · [ ] filas históricas siguen leyéndose bien.

### T-501 · Partir `v1.go` — P1
**Espec:** separar en `mounts.go` (NewV1Handler + orden de mounts),
`runsroutes.go`, `workflowroutes.go`, `encoding.go` (opResult/writeers/
helpers). CERO cambio de wire: el contract suite y el dual-run son el
guard. Precedente: la modularización run-routes/ del reference.
**Acepta:** [ ] ningún archivo httpapi >700 líneas por este código ·
[ ] contract + dual verdes sin tocar expectativas.

### T-502 · Partir `scim.go` — P1
**Espec:** `scimverify.go` (firma + parsing del evento), `scimdispatch.go`
(guardas + handlers por tipo), `scimroutes.go` (CRUD + resync + webhook).
Sin cambio de comportamiento; la suite lifecycle es el guard.
**Acepta:** [ ] 3 archivos <500 líneas · [ ] lifecycle + unit verdes.

### T-503 · Partir `queries.sql` — P1
**Espec:** sqlc acepta múltiples archivos: dividir por contexto
(engine.sql, workflows.sql, recovery.sql, scim.sql, evals.sql,
scheduler.sql, integraciones.sql, plataforma.sql). `make generate` debe
producir EXACTAMENTE el mismo queries.sql.go (drift check del ci lo
verifica solo).
**Acepta:** [ ] generate sin drift · [ ] ningún archivo de queries >500
líneas.

### T-504 · OTel trazas + `runs.traceId` — P1
**Espec:** tracer con Resource `service.name=janusly-go`; span raíz por
run en StartRun (traceId estampado en la fila), spans hijos por nodo en
el dispatcher; exporter console default / OTLP por env (espejo de la
postura del reference). Quitar `traceId` de la lista de divergencias
esperadas del comparador.
**Acepta:** [ ] runs.traceId poblado · [ ] spans por nodo visibles ·
[ ] dual-run: status/run/runs-list pierden esa divergencia esperada.

### T-505 · Granularidad del event-stream — P0
**Espec:** emitir `node.queued` en cada publicación ejecutable (la
transición que hoy solo marca run_nodes) y `node.started` al reclamar,
con los payloads del reference; el orden relativo run.started → queued →
started → succeeded por nodo debe igualar al de Node en el corpus dual
(caso status-linear pasa de 5 a 9 eventos y sale de la lista esperada).
Cuidar el costo: ambos INSERT viajan en transacciones ya existentes.
**Acepta:** [ ] 9 eventos en el run lineal de 2 nodos · [ ] dual-run OK
limpio en status/run · [ ] bench sin regresión >10% en start p95.

### T-506 · LISTEN/NOTIFY en el dispatcher — P1
**Espec:** el claim loop duerme sobre `WaitForNotification` del canal que
ya alimenta el hub SSE (payload = runId listo), con el poll actual como
fallback (timeout = intervalo configurado). Compartir la conexión LISTEN
del hub o una segunda hijackeada CON shutdown (lección T-185).
**Acepta:** [ ] latencia de despacho p50 <10ms con poll de 1s ·
[ ] failover ×3 sigue verde · [ ] goleak limpio.

### T-507 · Barrido EXPLAIN de la ola 6 — P1
**Espec:** test de integración que corre `EXPLAIN (FORMAT JSON)` sobre
las queries calientes nuevas (SCIM state/mappings, heatmap 90d, health
signals, eval examples, experiments, recovery debounce) contra datos
sembrados realistas y FALLA ante Seq Scan en tablas grandes; añadir los
índices que falten con el patrón two-file (migration + production-rollout).
**Acepta:** [ ] cero seq-scans no justificados · [ ] índices nuevos con
sus dos archivos · [ ] lista de queries exoneradas con razón.

### T-508 · Perfil de allocs + `safePersist` — P1
**Espec:** capturar pprof heap/allocs durante `make bench`, commitear el
perfil como artefacto, y atacar los 3 hot-spots mayores (candidato
conocido: `SafePersistPayload` re-serializa el árbol completo por
evento — evaluar redacción en streaming o cache del marshal).
**Acepta:** [ ] perfil commiteado con lectura en BENCH.md · [ ] ≥1
optimización medida (allocs/op del hot path −20% o veredicto documentado
de por qué no).

### T-509 · Batch de eventos en completion — P2
**Espec:** agrupar los INSERT de run_events de una misma transición
(succeeded + readiness) en un multi-VALUES; mantener orden y payloads
byte-idénticos (goldens + dual son el guard).
**Acepta:** [ ] round-trips de la completion −N medidos · [ ] paridad
verde.

### T-510 · k6-soak confiable + re-soak 24h — P0
**Espec:** en `k6-soak.js`, etiquetar requests con `name` fijo por
escenario (jamás URLs con runId — hoy 800k series y k6 ~100MB); añadir
`--no-thresholds --summary-trend-stats` mínimos; verificación de humo
`SOAK_DURATION=3m`. Relanzar el soak de 24h en la base aislada y anexar
el veredicto a REPORT-W6.
**Acepta:** [ ] k6 RSS plano en corrida de 1h · [ ] soak 24h completo con
veredicto en SOAK.md · [ ] REPORT-W6 actualizado.

### T-511 · goleak + fuga de conexiones como gate — P0
**Espec:** `goleak.VerifyTestMain` en engine y httpapi (allowlist mínima
documentada por goroutine legítima de proceso); test de integración que
levanta N=10 harnesses, los cierra, y asevera que `pg_stat_activity`
vuelve al baseline (la clase de bug del hub LISTEN, convertida en CI).
**Acepta:** [ ] goleak verde en ambos paquetes · [ ] test de baseline de
conexiones en la suite · [ ] allowlist con razón por entrada.

### T-512 · `runner.Group` de sweeps — P1
**Espec:** los ~8 goroutines sueltos de cmd/api (reaper, upstream,
schedule, healing, purge, reconcilers, hub) pasan a un grupo con: arranque
nombrado, panic-recovery por sweep (log + restart con backoff, jamás caer
el proceso), y shutdown ordenado en SIGTERM (drenar antes de cerrar pools).
**Acepta:** [ ] panic inyectado en un sweep no mata el proceso y el sweep
se reinicia · [ ] SIGTERM drena en orden · [ ] goleak sigue verde.

### T-513 · Tope global de pools externos — P1
**Espec:** además del cap 5/org de db-tools, un semáforo de PROCESO
(default 25, env) sobre el total de conexiones externas; al tope, el
tool responde `{ok:false, error:"db_pool_exhausted"}` never-throw.
**Acepta:** [ ] 6 orgs × 5 pools respetan el tope global · [ ] sobre
limpio al saturar · [ ] métrica gauge del uso.

### T-514 · Superficies AI restantes — P1
**Espec:** portar las 5 rutas con el contrato AI-fallback intacto
(free_json default, degradación a `{mode:"fallback", aiError}`), presupuesto
por el gate existente, y evidencia AI separada de la determinista (posturas
de las olas 4-5). `/ai/health` = snapshot de configuración/presupuesto sin
tocar proveedor. El web deja de degradar en esos botones.
**Acepta:** [ ] 5 rutas con paridad de shape vs reference · [ ] $0 sin
API key (fallback probado) · [ ] smoke del web con los botones vivos.

### T-515 · Auto-healing con LLM — P1
**Espec:** detrás del doble opt-in existente + budget gate: la propuesta
puede venir del LLM (prompt con firma+contexto scrubbed, salida = el
MISMO grammar de patch exacto de la ola 5) con `harden_retries` como
fallback determinista; la validación sandbox y el ack de riesgo NO
cambian (el LLM propone, jamás aplica).
**Acepta:** [ ] propuesta LLM validada en sandbox · [ ] sin key → cae al
determinista actual · [ ] presupuesto respetado con contador.

### T-516 · Billing — P1
**Espec:** `GET /billing/usage` (agregados de usage_events por mes/
proveedor/modelo, acotado como Operations), `GET/POST /billing/budget`
(org config existente `ai.budgetMonthlyUsd` + policy), y
`GET/POST /workflows/{id}/budget` (tabla workflow_budgets del baseline;
el gate compuesto org→workflow se consulta en GuardedGenerateText).
**Acepta:** [ ] budget por workflow muerde antes que el de org ·
[ ] paneles del web dejan de degradar · [ ] shapes vs reference.

### T-517 · Replay-lab — P1
**Espec:** `POST /runs/replay-lab` (re-ejecución sandbox de un run
histórico con overrides de input) + `/fork` (variante con workflow
editado), ambos `replayMode="validation"` SIEMPRE (write-sides
saltados), linaje trace-only, audits replay_lab.* ya en catálogo.
**Acepta:** [ ] replay jamás ejecuta write-sides · [ ] fork corre el doc
editado sin tocar versiones · [ ] linaje visible en el detalle.

### T-518 · Recovery V2 reads — P1
**Espec:** proyecciones de lectura sobre las tablas ya existentes:
`/recovery/cases` (casos durables con keyset), `/recovery/ledger`
(impact events con ventana), `/recovery/my-wins` (atribución por
usuario). Solo reads: cero autoridad nueva.
**Acepta:** [ ] shapes vs reference · [ ] keyset con tope · [ ] Activity
del web los consume sin degradar.

### T-519 · Identidad restante — P2
**Espec:** `GET /organizations` (memberships del caller),
`POST /users/me` (perfil), página de aceptación de invitación
(`POST /auth/invitations/accept` con el token de la invitación), y
`POST /plugins/install` (stub honesto con audit, como Node).
**Acepta:** [ ] switcher multi-org del web funciona · [ ] aceptación
end-to-end con invitación real · [ ] shapes vs reference.

### T-520 · `/causal` — P2
**Espec:** portar el razonador causal determinista (sin LLM, siempre
disponible) con su shape de respuesta.
**Acepta:** [ ] paridad de shape · [ ] panel del web vivo.

### T-521 · S3 SigV4 + HTML de pdf — P2
**Espec:** driver S3-compatible real (SigV4 propio sobre FetchHTTPTarget,
sin SDK) para el object store; dialect HTML de pdf.generate (subset
seguro → bloques del escritor propio).
**Acepta:** [ ] round-trip contra MinIO local · [ ] HTML subset
renderiza; lo no soportado degrada visible.

### T-522 · embed.FS del dist web — P2
**Espec:** `go:embed` del build de Vite servido por el binario bajo un
flag; SPA fallback a index.html; los assets con cache headers.
**Acepta:** [ ] binario único sirve el web completo · [ ] smoke de tabs
contra el binario embebido.

### T-523 · ARCHITECTURE.md — P1
**Espec:** un documento con 4 diagramas mermaid (ciclo de vida
run/nodo con CAS points y reaper; secuencia subworkflow con checkpoint
atómico y handoff; mapa de módulos internal/* con dependencias
permitidas; claim ladder + due-clock) + ADRs de una página: due-clock vs
BullMQ, sesgos zoned-window, orphan-tolerant, sweeps vs colas, serie
T-500.
**Acepta:** [ ] 4 diagramas renderizan · [ ] ADRs enlazados desde el
README del pilot.

### T-524 · Bookkeeping del PLAN — P2
**Espec:** voltear a done/superseded los punteros stale de la tabla de
fases (T-101/103/104, T-201..T-305, T-400) con nota de dónde se cumplió
cada uno.
**Acepta:** [ ] cero filas con estado engañoso.

### T-525 · Helper `route()` — P1
**Espec:** `route(mux, "GET /x", gate, core)` que registra en routeAuthz
Y monta en un solo punto — montar sin gate deja de compilar; migrar los
mounts existentes mecánicamente (el sweep de registry verifica que nada
se perdió).
**Acepta:** [ ] boilerplate −400 líneas · [ ] sweep completo verde ·
[ ] imposible montar ruta gateada fuera del helper (lint rule o tipo).

### T-526 · Partir `complete.go` — P1
**Espec:** `terminalfailure.go` (DLQ + hook + serialize) y `readiness.go`
(fan-in + enqueue) fuera de complete.go; cero cambio de SQL ni de
transacciones (los tests de concurrencia son el guard).
**Acepta:** [ ] archivos <500 líneas · [ ] suite engine + HA verdes.

### T-527 · Vistas tipadas núcleo — P1
**Espec:** structs con tags JSON para los wires de runs, dlq y workflows
(las 3 superficies más consumidas), reemplazando los map[string]any de
los handlers; el dual-run y el contract suite pinean que el wire no se
movió ni un byte.
**Acepta:** [ ] 3 superficies tipadas · [ ] dual 27/27 intacto ·
[ ] typo de key = error de compilación (demostrado).

### T-528 · `internal/webhooksig` — P1
**Espec:** extraer el 80% común de los 5 verificadores (parse t=/v1=,
tolerancia, constant-time, multi-candidato) con posturas por proveedor
como config (formato del header, ventana, esquema HMAC); migrar WorkOS,
external-runtime, PagerDuty y Slack; los tests existentes de cada uno
son el guard.
**Acepta:** [ ] 4 verificadores sobre el módulo común · [ ] matrices de
firma existentes verdes sin tocar casos.

### T-529 · `make verify` + `make seed` — P1
**Espec:** `verify` = generate+drift → build → lint → unit → integration
→ parity (para-en-el-primero, tiempos por etapa); `seed` = org demo
determinista (workflows con schedule/subworkflow/triggers, runs verdes y
fallidos, DLQ con firmas repetidas, incidentes, credenciales dummy).
**Acepta:** [ ] verify de una orden · [ ] seed idempotente y el web se
ve poblado.

### T-530 · CLI `janusly-admin` — P2
**Espec:** subcomandos redrive (por dead-letter o firma), schedules
resync/list, credentials health, runs inspect — sobre las rutas
existentes con service token (nunca SQL directo).
**Acepta:** [ ] los curls del runbook tienen subcomando · [ ] --json
para scripting.

### T-531 · Caos de Postgres — P0
**Espec:** `run-chaos.mjs`: tráfico sostenido → `docker stop` del
Postgres a mitad de vuelo → verificar que el binario NO muere, los
sobres degradan limpio, y al `docker start` los pools reconectan solos y
TODOS los runs pre-caída llegan a terminal (reaper + due-clock + outbox
reparan); ×3 corridas. Es el gemelo de run-failover con la base como
víctima en vez de la réplica.
**Acepta:** [ ] cero runs perdidos tras la caída · [ ] reconexión sin
reinicio del proceso · [ ] exactly-once se sostiene · [ ] ×3.

### T-532 · Cobertura con piso + 6 paquetes — P1
**Espec:** `-coverprofile` en make ci con piso por paquete (arrancar en
el valor actual, nunca bajar); unit tests reales para orgconfig
(resolución en capas), objectstore (traversal + escalera), packs
(validación de boot), prompts, contract y migrate (drift).
**Acepta:** [ ] piso pineado en ci · [ ] los 6 paquetes con tests
propios que fallan ante mutación obvia.

### T-533 · Fuzzing de parsers — P0
**Espec:** `go test -fuzz` corpus + lane acotada (30s por parser en ci,
larga bajo demanda) para: el parser cron de 5 campos (jamás panic, jamás
fecha imposible), el parser CloudEvents estricto (jamás aceptar campo
desconocido, jamás panic con UTF-8 roto), y el escritor PDF (salida
siempre PDF-válido o error limpio ante markdown hostil).
**Acepta:** [ ] 3 fuzz targets con corpus semilla commiteado · [ ] lane
en ci · [ ] hallazgos (si los hay) arreglados con su caso fijado.

### T-534 · Property tests SCIM — P1
**Espec:** generador de secuencias aleatorias de eventos SCIM
(create/update/delete/group add-remove/group delete, timestamps
desordenados, emails colisionantes) que tras CADA secuencia asevera las
invariantes: jamás resurrección de inactivo con ts viejo, jamás clobber
de fila human-invited, occurrence/join siempre consistentes, replay del
mismo event-id = no-op. Semilla fija reproducible + shrinking manual del
caso mínimo al fallar.
**Acepta:** [ ] ≥200 secuencias por corrida en ci · [ ] invariantes
formuladas como funciones puras reutilizables · [ ] caso mínimo impreso
al fallar.

### T-535 · Bench de fallo parcial — P1
**Espec:** escenario k6 "mundo hostil": upstream degradado pausando
workflows + DLQ recibiendo fallos continuos + breaker disparando, y
MEDIR que las lecturas (runs/dlq/health) mantienen p95 <2× el baseline
sano; el resultado entra a BENCH.md como escenario permanente.
**Acepta:** [ ] p95 de lecturas acotado bajo caos · [ ] escenario en
make bench · [ ] regresiones futuras visibles en la serie.

### Dependencias de la ola

- T-500 antes de tocar el corpus dual (T-505 lo edita también — coordinar
  la lista de divergencias esperadas en un solo commit cada vez).
- T-511 y T-512 antes de T-506 (el despertador nuevo nace con goleak y
  shutdown ordenado como red).
- T-525 (helper route) antes de T-514/T-516/T-517/T-518/T-519/T-520 (las
  rutas nuevas nacen con el patrón nuevo, no migradas después).
- T-510 (k6 confiable) antes de T-535 (el bench hostil usa el mismo k6).
- T-503 (queries multi-archivo) antes de T-507 (el barrido EXPLAIN anota
  por archivo de contexto).
