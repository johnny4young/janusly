# go-pilot — journal de ejecución

Registro cronológico: qué pasó, fricciones con ejemplos, decisiones de
terreno. Vive en la rama para que cualquier agente (o Johnny) lo lea desde
cualquier checkout; sobrevive o muere con la rama, y sus conclusiones se
consolidan en el informe de la puerta D15.

---

## 2026-07-30 — Bootstrap (T-000) y re-encuadres v4

- Worktree + rama creados; módulo `go/` compilable; Compose propio
  (PG 18 @ 4632); migraciones compartidas aplicadas con el tooling del repo.
- **Fricción PG 18**: las imágenes Docker 18+ montan el volumen en
  `/var/lib/postgresql` (no `.../data`); el contenedor moría hasta ajustar
  el compose. Anotado también para el futuro upgrade del stack Node.
- **Fricción menor**: golangci-lint atrapó `errcheck` en el primer archivo —
  el arnés de lint funciona desde el minuto uno.
- Suerte de toolchain: la máquina ya tenía Go 1.26.5 y golangci-lint 2.12.2
  exactos.
- Directivas v4 de Johnny incorporadas el mismo día: base `develop` (re-base
  + DB regenerada 62→71 tablas), alcance final Backend+UI sin excepciones
  (fases F0–F3, inventario de 108 rutas + SSE medido del código del web),
  y comentarios de código sin naming interno del plan (scrub aplicado; mi
  primer perl cosió mal una línea de main.go — corregido a mano).

## 2026-07-30 — Diff-review nº1 de develop (pin c1aa11e2 → 0f294ad2)

- 5 commits nuevos: calificación local (fronteras de seguridad, rollback de
  upgrade, instalación limpia, backup/restore portable) + simplificación del
  human form en el web. 45 archivos, +4.098/−369.
- **Sin migraciones nuevas** (29 se mantiene) y **el inventario de 108 rutas
  del web no cambió** (re-grep idéntico).
- Único toque de API: `http.ts` endureció CORS — ya no responde `*` ni
  `"null"`; omite los headers credenciados salvo Origin explícitamente
  permitido. Relevante para la paridad de headers de F1 (anotado en el
  plan).
- pnpm subió a 11.17.0 (packageManager); corepack lo maneja solo.
- Rebase del piloto sobre 0f294ad2: limpio; build/lint/test verdes.
- Robustez multi-agente: nace `go/AGENTS.md` (onboarding para cualquier
  agente), este journal se muda a la rama (antes vivía gitignored en el
  checkout de Johnny — invisible para otros agentes), y el plan declara la
  independencia de rutas (§12).

## 2026-07-30 — Config + boot + observabilidad (T-001)

- `internal/config`: carga validada con defectos y rangos; agrega TODAS las
  violaciones en un solo error (una instalación rota conoce todos sus
  problemas de una vez, no de a uno).
- `internal/boot`: pool pgx acotado con ping al arrancar; probe de
  migraciones que aborta ante journal ausente/vacío con el remedio en el
  mensaje (`make migrate`).
- `internal/httpapi`: mux público (`/healthz`) y mux interno separado
  (métricas Prometheus + pprof, ligado a 127.0.0.1) — perfiles jamás a un
  proxy de distancia del público.
- `cmd/api`: arranque completo con apagado limpio (SIGTERM drena con gracia
  de 10s; verificado exit=0).
- Verificación en vivo además de los tests: healthz responde, métricas traen
  el runtime de Go, y contra una DB sin migrar el binario muere en el boot
  con SQLSTATE y remedio — no sirve tráfico a medias.
- Dependencias añadidas: pgx v5.10.0 (pin del plan), client_golang v1.24.1.

## 2026-07-30 — Persistencia tipada (T-002)

- Inventario del esquema real ANTES de escribir consultas: sorpresas
  documentadas (`attempts` plural, `dead_letters.status`, `hold_until`);
  todos los NOT NULL sin valor traen default → inserts mínimos.
- `go_pilot_wakeups` nace (run_nodes no tiene columna de despertar); primera
  migración piloto aplicada solo a `janusly_go`.
- sqlc pinneada como tool de go.mod (sin brew — cualquier agente la obtiene
  con el módulo); esquema para sqlc por `pg_dump` regenerable.
- 15 consultas: round-trips, keyset con desempate por id (probado con
  timestamps forzados a empatar), transiciones CAS (probado que el segundo
  escritor pierde), claim único de dead letters, ciclo de wakeups.
- **Hallazgo que precisa el plan**: jsonb de Postgres normaliza al escribir
  (claves alfabéticas) — igual para Node; nuestro passthrough evita el
  re-encodeo de Go, no la normalización de PG. El test lo fija.
- Gotchas sqlc: overrides de timestamptz necesitan la forma calificada Y la
  simple; mezclar sqlc.arg() con $N posicionales rompe la numeración.
- Fricción de tests contra DB persistente: ids fijos chocan entre
  re-ejecuciones → helper `uid()` por invocación.

## 2026-07-30 — Dominio + validación del subconjunto (T-003)

- Porte check por check y EN EL ORDEN de la referencia: 16 códigos con sus
  mensajes exactos (leídos de la fuente en el pin, con cita archivo:línea en
  cada test).
- Hallazgo: Node ya tiene `unsupported_node_type` — el código piloto quedó
  para el caso distinto "válido en la plataforma, no ejecutable aquí aún".
- Semántica JS portada con intención: truthiness (`!config.url` = ausente,
  "", null, false y 0), coerción String(), y el guard de inputs.* en aristas
  con el mismo regex que ignora literales entre comillas.
- Paridad de mensaje verificada contra la corrida real de Node de hace unos
  días: `Declared default for $.start is invalid: $.start must be string,
  got number` — byte a byte.
- Las dos fixtures de docs/workflows.md (§2 condicional, §6 approval)
  validan limpias.
- Fricción menor: mapas Go sin orden → iteración ordenada para issues
  deterministas (Node usa orden de inserción; comparación por conjuntos).

## 2026-07-30 — startRun transaccional + defaults (T-004)

- El invariante fundacional portado con su forma exacta: raíces `queued` con
  `attempts=1` y `state_json {}`, resto `pending`; evento `run.started` con
  payload `{workflowVersionId}`; cadena de fallback del versionId igual a la
  referencia.
- NOTIFY viaja DENTRO de la transacción — Postgres lo entrega solo al
  commit, así que el despertar de workers no puede adelantarse a un rollback.
  Probado con un LISTEN real que recibe el run id.
- Atomicidad probada con inyección: un wrapper de DBTX falla en el tercer
  statement y las tres tablas quedan en cero — el seam `wrapTx` es el patrón
  de arnés en acción.
- `applyInputDefaults` portado del pin (que ya traía un endurecimiento de
  `__proto__` posterior a mi versión TS — en Go es gratis, test igual);
  la distinción undefined/null del JS se volvió (value, present).
- El caso estrella verificado de punta a punta: payload estilo trigger
  satisface requeridos vía defaults y lo persistido lleva defaults + claves
  del trigger juntos.
- 9 tests portados/nuevos citando el `it(...)` TS de origen.

## 2026-07-30 — cola propia: claim loop + worker pool (T-005)

- El corazón del piloto late: `SKIP LOCKED` como operación de consumo,
  N goroutines reclamando de a un nodo, LISTEN/NOTIFY con fallback de
  polling, drain limpio (el trabajo reclamado termina en un context
  desacoplado de la cancelación — cero filas `running` huérfanas).
- La decisión de arquitectura del día: un `pg_advisory_xact_lock` por run
  serializa las transacciones de completación. Con eso, completación +
  evento + readiness + queue de sucesores + rollup del run son UNA
  transacción — Node necesita generaciones de publicación y reconcilers
  porque BullMQ es un segundo store; aquí ese triángulo desaparece.
- Fricción valiosa: el primer run del test de fan-out contó 55 nodos en
  vez de 50 — el claim es GLOBAL (correcto: un pool consume todos los
  runs) y estaba ejecutando sobrantes encolados de tests anteriores en la
  DB persistente. Los probes ahora se scopean por runID; el
  comportamiento de la cola quedó como debe ser.
- Paridad leída de la fuente: regla de 8 KB para el output inline del
  evento, centinela de truncado con preview = cap/2, y el detalle fino
  del +1 ms en `run.failed` para que el keyset nunca ordene la
  consecuencia agregada antes de su causa.
- 3 corridas extra de la suite de carreras con `-race`: estable.

## 2026-07-30 — gramática: templates + expresiones (T-006)

- Nace `internal/grammar` con las dos gramáticas del runtime portadas de la
  fuente canónica (`@janusly/shared/src/expression.ts` +
  `packages/engine/src/template.ts`), con sus tests TS como especificación:
  ~55 aserciones portadas citando cada `it(...)` de origen (la card pedía
  ≥25).
- Decisión: portar la gramática COMPLETA (==/!= laxos, contains,
  startsWith, matches con glob acotado, in, arrays, null), no el
  subconjunto de la card — el costo marginal era bajo y evita una
  divergencia gratuita.
- El hallazgo del día: probando un caso inventado descubrí que
  `(A || B) && C` TAMPOCO funciona en Node — los grupos booleanos entre
  paréntesis compuestos con otro operador están fuera de la gramática de
  referencia (verificado en vivo con node --experimental-strip-types).
  El port reproduce el rechazo byte a byte y un test lo fija para que
  nadie "arregle" la paridad por accidente.
- La parte honesta del port fue `jsvalue.go`: undefined vs null,
  truthiness, Number() con hex/octal/Infinity/""→0, y orden de strings
  por unidades UTF-16 (no code points) — cada coerción auditable en un
  archivo.
- Templates: single-ref conserva tipos nativos (arrays sobreviven),
  multi-ref interpola (objetos como JSON), env/secret con piso de 4
  caracteres para la lista de redacción, secret faltante = fallo duro,
  deferredRoots verbatim para loop/item. RedactValues cierra el ciclo
  render→scrub end-to-end.
- El seam del domain quedó cableado: `grammar.DomainValidator` produce
  `condition_invalid_expression` con el mensaje verbatim de referencia
  (sin prefijo — workflow-validation.ts:151 usa `??`, leído dos veces).

## 2026-07-30 — executors base + semántica de aristas (T-007)

- La gramática y la cola se encontraron: nace `internal/executors`
  (noop/transform/condition puros — jamás tocan la DB) y el `Dispatcher`
  del engine (contexto → render con tracking de secretos → evento de
  evidencia → executor → scrub). El pipeline entero de un nodo en ~90
  líneas auditables.
- La corrección del día ES a mi propia card: escribí "skip propaga" y
  Node no hace eso — un `skipped` satisface sus aristas y el sucesor
  incondicional EJECUTA. Leer la fuente antes de portar volvió a pagar:
  el fixture ahora fija la semántica real, no la que yo recordaba.
- Segundo hallazgo de referencia: el scan de Node es UNA pasada en orden
  de declaración; un dependiente-de-skippeado declarado antes que su
  predecesor queda atascado para siempre (nada re-dispara el scan). El
  piloto itera a punto fijo — superior, documentado, idéntico en
  workflows bien ordenados.
- Bug propio encontrado por los tests: slices nil en Parse rompían el
  round-trip del snapshot (`"edges":null`); los timeouts silenciosos que
  causaba inflaban la suite de 3s a 41s. Arreglado en la raíz.
- Bonus que cerró deuda: `template.unresolved_path` + política estricta
  + proyección de outputs declarados (con máscara de secret/env) — tres
  cosas que el plan tenía anotadas como divergencias/diferidos, todas
  dentro del alcance natural de esta tarea.

## 2026-07-30 — modelo de fallo: escalera de retries + DLQ (T-008)

- Otra vez la fuente corrigió a la card: mis números de backoff eran
  inventados; el evaluador real usa full jitter `[delay/2, delay]` y
  patrones `retryOn`/`ignoreOn` sobre labels clasificados (familia
  `5xx`, `timeout` por wording, `network` por códigos). Portado con
  rand inyectado — cero sleeps en los tests unitarios.
- La decisión que más me gusta del día: el retry diferido no necesita
  scheduler. El claim lleva un anti-join contra `go_pilot_wakeups`
  (`wake_at > now()`), así que la fila se vuelve reclamable en el
  instante exacto en que su reloj pasa — el sweeper es solo garbage
  collection y un empujón a workers ociosos. La corrección no depende
  de ningún proceso intermedio.
- El fallo terminal ahora es la transacción completa de Node: CAS del
  nodo + fila `dead_letters` (snapshots workflow/node exactos para
  replay — sin truncar pero key-redactados) + `node.failed` + flip del
  run. Un fallo del insert del DLQ revierte todo — nada de runs a
  medio fallar.
- De paso cayó el safe-persist completo: el regex cerrado de claves
  sensibles portado de sensitive-keys.ts, compuesto con el acotado de
  T-005. `authorization: "Bearer …"` en un config aparece como
  `[redacted]` en los tres JSON del DLQ — probado contra la fila real.
- El test de retry diferido es el que más confianza da: agenda un retry
  a 60s, prueba que NADIE lo reclama en 300ms, mueve el reloj en SQL y
  ve al poll cadence reclamarlo — sin esperas reales.

## 2026-07-30 — waiting: wait_until + approval/resume (T-009)

- El primer estado durable no-terminal: un nodo pausa, el run sigue
  `running`, y la resurrección — humana o de reloj — pasa por UN solo
  camino (`ResumeRun`) con el CAS waiting→succeeded como guardia de
  idempotencia. Doble resume, cancelación previa o disparo duplicado del
  timer: todos pierden limpio.
- Dos correcciones más de card contra fuente: (1) el resume de approval
  produce output VACÍO siempre — la decisión vive en el timeline, no en
  el output (histórico de Node); (2) la config es `duration` ISO-8601 /
  `until` instante, no `durationMs`. El parser de duraciones e instantes
  se portó completo, con la validación de campos de Node (días
  imposibles, bisiestos, timezone obligatoria).
- El timer no estrenó infraestructura: `go_pilot_wakeups` + sweeper ya
  existían de T-008; ahora un wakeup vencido de un nodo waiting se
  resuelve vía ResumeRun — el mismo camino del resume manual, igual que
  Node (handleWaitResume → resumeRun). Una sola pieza nueva de SQL.
- Postura honesta del piloto: approval con políticas de deadline falla
  determinista en vez de ejecutar sin la supervisión declarada.
- Detalle que me gustó portar: `until` en el pasado → delayMs 0, resume
  inmediato — un workflow guardado válido ayer no puede volverse
  inválido hoy en runtime.

## 2026-07-30 — redrive: el DLQ revive runs (T-010)

- La cuña de recuperación en miniatura: fallo permanente → dead letter →
  upstream sana → redrive → run `succeeded`. El test lo cuenta como
  historia (upstream down/healed con un atomic.Bool) y verifica las dos
  ejecuciones exactas del nodo frágil.
- Todo es una transacción bajo el advisory lock del run: claim del DL
  (CAS sobre replay_claimed_at, la misma columna de Node), failed→queued
  con attempts+1, run revivido, evento, NOTIFY. La propiedad que más
  importa: si el nodo ya no está `failed`, el claim NO se quema — la tx
  revierte entera y el 409 es reintentable.
- Cross-org es un not-found indistinguible (la fila no existe para otro
  tenant) — el mismo principio de invisibilidad del API de Node.
- Paridad heredada curiosa: nadie limpia error_json al completar un nodo
  redriveado — la evidencia del fallo viejo convive con el output nuevo.
  Node hace lo mismo; queda fijado como comportamiento, no como bug.

## 2026-07-30 — http executor + SSRF con dial pinneado (T-011)

- La pieza de seguridad del piloto. La clase de bug que este diseño hace
  imposible: rebinding DNS (IP pública al validar, privada al conectar).
  El resolver se consulta UNA vez; el DialContext marca la IP exacta
  validada; un host no validado ni siquiera obtiene socket. El test lo
  prueba por construcción: resolver que cambia de respuesta + contador
  de llamadas == 1.
- La duda que la card pedía verificar quedó resuelta en fuente: no-2xx
  SÍ falla el nodo, con un error tipado cuyo statusCode alimenta la
  clasificación 5xx de retries. Y encontré un bug propio en el camino:
  mi dispatch envolvía errores en errors.New tras redactar, PERDIENDO
  name/code/statusCode — la escalera habría quedado ciega para el nodo
  más común del producto. Ahora la identidad sobrevive la redacción.
- Bypass fiel: ALLOW_PRIVATE_HTTP_TARGETS=true desactiva TODO (ni
  pinning) — igual que Node, que devuelve la URL sin agent. Mi primera
  versión pineaba también en bypass y el guard del socket bloqueaba los
  httptest servers: el fallo del test me enseñó la semántica real.
- Matriz SSRF: 19 casos de clase + resolución-a-privada (incluida la
  respuesta DNS mixta: UNA privada envenena el set) + refusals del dial.
  Todos los mensajes verbatim de Node.
- Watch-item: un flake 1/~10 en TestDelayedRetryIsNotClaimableUntilDue
  bajo suite completa; pasa 6/6 después. Si recurre, capturar detalle.

## 2026-07-30 — API /v1 + goldens de Node (T-012)

- La paridad se volvió medible: levanté el stack Node COMPLETO desde el
  worktree limpio (el checkout principal tenía ediciones de otra sesión
  — capturar de ahí habría contaminado la referencia) y capturé 17
  respuestas reales como goldens versionados.
- El hallazgo que justifica todo el ejercicio: run desconocido y run de
  otro tenant son AMBOS `403 runs_forbidden` — invisibilidad
  indistinguible. Yo habría escrito 404. El golden me corrigió antes de
  escribir una línea del handler.
- Ocho rutas montadas sobre el engine con el envelope exacto; las
  columnas que el piloto aún no llena salen como NULL explícito — el
  key-set del golden se preserva completo para que el web de F1 no
  necesite tolerancia a claves ausentes.
- La lección de testing del día: con claims globales (correcto en
  producción), los pools de paquetes de test en paralelo se servían
  nodos ajenos — un stub noop "completó" un http bloqueado de otro
  paquete. Lane -p 1 + borrado determinista del wakeup en la tx de
  completación. El bug de test reveló una mejora real del engine.
- El binario es uno solo por ahora (API + workers) — los procesos se
  separan cuando la escala lo pida; el engine ya soporta N consumidores.

## 2026-07-30 — paridad semántica F01–F10 (T-013)

- El momento de la verdad del piloto: las diez fixtures (once corridas,
  F02 partida true/false) proyectadas idénticas contra los goldens del
  Node real — A LA PRIMERA. Todo el trabajo de leer-la-fuente-antes-de-
  portar de las tareas anteriores se cobró aquí: cero sorpresas
  semánticas en lineal, ramas, http, DLQ, redrive, approval, timers,
  defaults, diamante y templates no resueltos.
- UNA divergencia, y es honesta: el replay de Node re-arma el nodo con
  attempts=1; el redrive del piloto preserva el rastro (attempts=3).
  Documentada en la tabla del runner con su porqué — evidencia vs
  re-armado limpio, una decisión de producto para F2.
- El arnés quedó reproducible: fixtures compartidas declarativas, stub
  upstream determinista clonado en ambos runners, `make parity` como
  comando único. Regenerar goldens = un script contra el stack del pin.

## 2026-07-30 — e2e del binario real (T-014)

- Los dos ciclos del README, por HTTP, contra el binario compilado de
  verdad: la cuña de recuperación completa (500 persistente → DLQ →
  upstream sana → redrive → succeeded con el transform downstream
  leyendo el statusCode) y la puerta de operador (approval → resume →
  outputs proyectados combinando el default declarado del input con el
  estado del downstream).
- El teardown no es cortesía: cada corrida manda SIGTERM y FALLA si el
  binario no drena en 15s — el contrato de lifecycle del worker se
  prueba en cada ejecución del suite.
- Un bug de arnés instructivo: t.TempDir() del primer test se llevaba el
  binario compartido al terminar; temp estable propio y listo.

## 2026-07-30 — MCP en proceso sobre el engine (T-015)

- El objetivo a corto plazo de la visión toma forma: un agente puede
  operar el motor por MCP sin que exista NINGÚN otro servicio — el
  binario stdio carga el engine en proceso, corre el worker pool, y
  expone las seis herramientas del loop del operador.
- El e2e ES la conversación con Claude, scriptada: guardar el workflow,
  arrancarlo, verlo morir en el DLQ, sanar el upstream, redrivear,
  verlo triunfar, e inspeccionar el timeline con node.redriven — con el
  doble redrive respondiendo un isError legible, no un crash.
- Gotcha del SDK que costó un test rojo: json.RawMessage en los args
  deriva schema de array (es []byte) y el SDK valida ANTES del handler.
  Documentos como map[string]any.
- Falta la demo manual con Claude real (snippet listo en README) — la
  anoto cuando Johnny la corra o la corramos juntos en una sesión.

## 2026-07-30 — números: carga, RSS, pprof (T-016)

Metodología: loadgen propio en Go (sin k6 — divergencia anotada), 30s
por escenario, misma máquina, cada backend sobre su propio Postgres
local. Sin umbral pasa/no-pasa: números para aprender.

| Escenario | Go | Node |
| --- | --- | --- |
| start 10 VU (runs/s, p50) | **187.9**, 34.6ms | 45.9, 195.9ms |
| start 50 VU (runs/s, p99) | 49.3, 19.9s (c=8) / 48.6, 2.3s (c=32) | 53.4, 1.9s |
| list 50 VU (RPS, p50) | **2800**, 17.9ms | 1085, 41.6ms |
| diamond 10 VU (runs/s) | **136.4** (545 nodos/s) | ~29.5 (5 VU, acotado) |
| RSS idle / pico | **21.9 / 34.3 MB** (1 proceso) | ~101 MB (api+worker) + Redis |

- Lo bueno: 4× en throughput de runs, 2.6× en lecturas, ~5× menos
  memoria en un solo proceso.
- Lo honesto: a 50 VUs el pool Go se cae de la mesa con c=8 (p99 20s) y
  subir a c=32 colapsa el diamond 8× — el sospechoso es el pool de DB
  fijo en 10 conexiones compitiendo entre 32 workers y los pollers del
  API. Sigue como follow-up: pool configurable, pools separados,
  retest. Node degrada con gracia (el modelo async de BullMQ paraleliza
  más allá de los hilos del SO) — lección de diseño real.
- Bonus inesperado: 2/445 diamantes de Node quedaron atascados para
  siempre (el join nunca disparó) — reproducción probable del hazard de
  ordering del readiness scan que ya reporté upstream. Go: 4100/4100.
- Perfil pprof de CPU del escenario diamond guardado en
  conformance/perf/pprof-diamond-cpu.pb.gz.

## 2026-07-30 — puerta D15: F0 cerrada (T-018)

- Las cuatro condiciones evaluadas y cumplidas; informe en REPORT-D15.md.
- La vertical completa del engine — cola propia, executors, fallo/retry/
  DLQ, waiting/resume, redrive, http/SSRF, API v1 con goldens, paridad
  F01-F10, e2e del binario, MCP en proceso, números — se ejecutó en una
  sola jornada de trabajo continuo contra el timebox de 3 semanas.
- Recomendación escrita: continuar por fases, con un F0.5 corto para el
  pool de DB y los goldens faltantes. La decisión es de Johnny.

## 2026-07-30 — ola 2 arranca: pools separados (T-019)

- El acantilado de 50 VUs era EXACTAMENTE el pool: separar API (10) de
  workers (concurrencia+2) llevó start@50VU de 49 a 275 runs/s con p99
  de 19.9s a 337ms — 59× en la cola. Las lecturas doblaron a 6220 RPS.
- El detour instructivo: el primer retest reportó 7628 errores a 500
  runs/s… del lado del LOADGEN (MaxIdleConnsPerHost=2 default de Go →
  churn de puertos efímeros). El backend estaba limpio: 11,966/11,966
  runs succeeded. Herramienta de medir también se calibra.
- Matiz honesto: diamond con c=32 rinde MENOS que con c=8 (90 vs 136
  runs/s) — advisory lock por run + muchos workers sobre pocos runs =
  contención. La concurrencia se dimensiona a runs concurrentes.

## 2026-07-30 — reaper de nodos atascados (T-020)

- El único modo de fallo que el claim atómico no puede auto-sanar — un
  worker muerto a mitad de ejecución — ya tiene su red: sweep periódico
  que convierte la fila `running` huérfana en la superficie ordinaria
  del operador (nodo failed + dead letter + run failed).
- La postura es la de Node y es deliberada: fail-into-DLQ, jamás
  re-ejecutar — el nodo atascado pudo haber cobrado la tarjeta antes de
  morir. El operador decide con el redrive.
- La elegancia del reuso: el reap ES FailNode — mismo CAS (un nodo que
  completó entre scan y write nunca se pisa), misma transacción
  terminal, mismo DLQ. El reaper son ~50 líneas de scan + loop.

## 2026-07-30 — cancelación de runs (T-021)

- La semántica fina de Node portada con sus dos sutilezas: (1) `running`
  se excluye del flip deliberadamente — el nodo en ejecución termina
  natural y el guard post-éxito evita que programe descendientes (el
  test lo prueba: completación tardía → nodo succeeded, downstream
  cancelado, run cancelado); (2) el mensaje del 409 lleva el literal
  "{{status}}" SIN interpolar + params.status — plantilla del cliente,
  no del servidor.
- Hallazgo de asimetría deliberada: cancel distingue 404 (no existe) de
  403 (otro tenant), mientras las LECTURAS de run mantienen ambos como
  403 indistinguible. Leer no revela existencia; actuar sí la requiere.
  Fijado con test para que nadie lo "arregle".

## 2026-07-30 — segunda pasada de goldens (T-022)

- Doce goldens nuevos, y el más valioso enseñó una lección de capas: el
  contrato v1 NO es la ruta legacy con envelope. En cancel, Zod valida
  la forma ANTES de los guards manuales — runId faltante es
  invalid_input {field:"runId"}, y reason es STRING opcional (mandar un
  objeto da 400 nombrando el campo). Mi puerto venía de leer la ruta
  legacy; el golden lo corrigió. Regla aprendida: para rutas /v1, el
  contrato Zod es la verdad, la ruta legacy es solo el handler.
- El replay de Node quedó clavado: éxito {ok:true}, conflicto con su
  mensaje largo y humano. Mi /v1/dlq/redrive propio convive con el
  alias /v1/dlq/replay de paridad — misma operación del engine, dos
  formas de wire.

## 2026-07-30 — el flake era un bug: EvalPlanQual en el claim (T-023)

- El watch-item de T-011 resultó ser el mejor bug de la ola: bajo READ
  COMMITTED, el claim de UN solo UPDATE-con-subquery sufre EvalPlanQual
  — cuando la fila cambió desde el snapshot del statement, Postgres
  re-chequea los quals sobre la versión nueva PERO el NOT EXISTS del
  wakeup se re-evalúa con el snapshot VIEJO, anterior al wakeup del
  retry. Resultado: un retry diferido de 60 segundos reclamado al
  instante, una de cada diez corridas.
- El camino del diagnóstico también cuenta: instrumentar el Fatal del
  test (node=succeeded/2, execs=2, wakeups=0), descartar procesos
  huérfanos, descartar drift del reloj del VM de Docker (69ms), y solo
  entonces releer el SQL con la lupa de EPQ.
- El fix es el patrón canónico: claim en dos statements dentro de una
  transacción — bloquear candidatos con SKIP LOCKED, luego UPDATE con
  todos los guards re-checkeados bajo snapshot fresco sobre filas que
  YA poseemos (sin re-evaluación EPQ posible). Treinta corridas
  seguidas en verde donde antes caía una de diez.

## 2026-07-30 — métricas Prometheus del engine (T-024)

- Serie propia janusly_go_* — deliberadamente NO reutilizo los nombres
  del exporter de Node: series nuevas de un backend nuevo, no impostores
  que confundirían dashboards durante la coexistencia F1-F3.
- La profundidad de cola es un Collector custom con caché de 5s: un solo
  GROUP BY acotado por scrape real, scrapes concurrentes coalescen — la
  misma postura anti-estampida del /health de Node.
- El e2e escrapea el puerto interno del binario real tras un run
  completo y exige las cinco series con valores.

## 2026-07-30 — make ci (T-025)

- Una orden, exit honesto: generate con guard de drift del código sqlc
  (si make generate cambia internal/store, el lane FALLA — el generado
  descuadrado se detecta aquí, no en review), build, lint, suite -race
  -p 1, y la paridad F01-F10 al final como sello.
- Deliberadamente local, sin workflow de GitHub: los push del repo
  privado cuestan dinero (regla de la casa) — la misma filosofía que
  mantiene el eval-gate de Node fuera de CI.

## 2026-07-30 — keyset real en /v1/runs (T-026)

- El cursor del contrato (`before=<iso>|<id>`) con la sutileza de que la
  respuesta NO lo devuelve: el cliente lo deriva de la última fila —
  igual que Node. El test camina 5 runs en páginas de 2 sin duplicados
  ni huecos, construyendo el cursor como lo hará el web.
- Hallazgo del filtro: workflowId en Node lleva un fallback OR para
  runs ad-hoc — los starts inline no tienen fila en workflow_versions,
  así que el filtro compara el version-id del run directamente cuando
  el join da NULL. Mi primera versión (solo el join) devolvía 0 para
  ad-hoc; el test lo cazó y la fuente dio la forma exacta.

## 2026-07-30 — rutas read de workflows (T-027)

- Las tres lecturas que la lista de Flows del web necesita: la fila de
  lista con sus agregados (runCount y lastRunStatus usando el MISMO
  match ad-hoc-aware que el filtro de runs de T-026 — la lección
  aprendida ayer aplicada hoy sin test rojo), latest con su contrato
  nullable (workflow sin versiones = null, no error), y versions
  newest-first.
- El gate del padre activo es una función compartida: param faltante
  nombra el campo, y desconocido/tombstone/cross-org son el MISMO
  workflow_not_found — la invisibilidad de tenancy otra vez.

## 2026-07-30 — headers de browser: CORS + request-id (T-028)

- El prerequisito silencioso de F1: sin esto, el fetch del web muere en
  preflight antes de tocar un handler. Portado verbatim de http.ts:
  echo condicional del Origin (jamás a uno no listado — y el test
  verifica que las listas fijas + Vary SÍ viajan igual, para no
  envenenar cachés), credenciales solo con echo, y las listas de
  headers exactas — incluida Last-Event-ID, que el SSE de T-031 va a
  necesitar.
- El x-request-id entrante se honra si es benigno (patrón estricto); un
  id hostil con CRLF se reemplaza por uuid — pequeño endurecimiento
  sobre Node anotado como mejora, no divergencia de forma.

## 2026-07-30 — inventario de gaps F1 (T-029)

- Leer api.ts del web antes de arrancar el dev server ahorró una tarde
  de sorpresas: el cliente prefija /v1 SOLO en los GETs de su set de
  lecturas (y des-envuelve el envelope él mismo), pero TODAS las
  mutaciones van a rutas legacy crudas. Mi superficie /v1 de escritura
  está... en el lado que el web no llama. Un handler, dos encoders —
  la misma arquitectura de alias de Node — entra en T-032.
- La buena noticia del inventario: las siete lecturas core ya están
  alineadas; los dev-headers del web son exactamente los que el pilot
  acepta; y el wrapper degrada offline-limpio, así que los paneles
  fuera de alcance (AI, credenciales, SCIM…) deberían mostrar estados
  vacíos amigables — el smoke de T-035 lo confirmará.

## 2026-07-30 — lecturas legacy de soporte (T-030)

- /health abierto con la forma del golden y un detalle de honestidad:
  queue.degraded sale de un ping real acotado a la DB, no de un true
  hardcodeado — el chip de Operations verá degradación de verdad si la
  DB se cae. /org/config devuelve la lista vacía que Node daría a una
  org fresca.
- La mitad del ticket fue DEPURAR el alcance contra la fuente: /ping no
  existe como ruta del servidor (falso positivo de mi inventario
  estático — estaba en un util del cliente), /users/me solo es POST de
  perfil, y la tarjeta de onboarding degrada amigable por diseño del
  wrapper. Tres stubs que NO había que construir.

## 2026-07-30 — SSE: el vivo del run (T-031)

- El protocolo del web hablado completo: handshake con retry hint,
  catch-up acotado desde el cursor compuesto (con el overlap deliberado
  que el cliente dedupe), tail vivo, run-status por cambio, heartbeat.
  El reemplazo estructural: donde Node publica por Redis, el pilot
  dispara NOTIFY dentro de cada transacción que escribe eventos — la
  señal viaja CON el commit, y el fallback de 1s convierte cualquier
  pérdida en retraso, jamás en agujero.
- El test e2e cuenta la historia entera por UNA conexión: replay del
  run.started, resume del approval, node.resumed y run-status succeeded
  llegando en vivo, y reconexión por cursor que NO repite lo visto.
- Bug de arnés instructivo: dos readFrames sobre el mismo bufio.Reader
  lanzaban dos goroutines lectoras robándose líneas — un pump por
  conexión y la verdad emergió.

## 2026-07-30 — el wire dual: aliases legacy (T-032)

- La pieza estructural de F1: un core por mutación que devuelve un
  resultado wire-agnóstico, y dos encoders — el crudo legacy que el web
  POSTea y el envelope v1. El drift entre las dos formas es
  estructuralmente imposible porque comparten el core: exactamente la
  arquitectura de alias de Node, en ~60 líneas de encoders.
- El wire de error legacy es {error: message, code, params?} — el campo
  se llama "error" y lleva el MENSAJE (no un objeto). Fácil de suponer
  mal; el docstring de sendError lo dice y el test lo fija.
- /dlq/counts salió real (GROUP BY de verdad) y el detalle /dlq?id=
  lleva el snapshot exacto con los overlays de recovery como null
  honesto. /dlq/queue quedó para T-044: está atado a severidad/SLA/
  owners de la maquinaria de recovery que el pilot no tiene aún.

## 2026-07-30 — soft-delete, trash, restore (T-033)

- El ciclo de la papelera completo con la regla de la casa intacta: un
  save jamás resucita un tombstone — el operador restaura explícito
  primero. El guard distingue por qué falló el PK: tombstone del mismo
  org (404) vs id de otro tenant (409).
- Bug latente cazado de rebote: last_run_status de las listas explotaba
  al escanear NULL para workflows sin runs — sqlc infiere los subqueries
  escalares (y hasta LATERAL) como non-null. La lista ACTIVA tenía el
  mismo bug dormido; el COALESCE('') + null en el wire arregla ambas.
- Lección operativa cara: kill %1 en shell no-interactivo no mata nada.
  Un binario de probe huérfano estuvo reclamando nodos con executors
  reales y fabricó dos fallos fantasma que perseguí en serio. pkill por
  ruta tras cada probe, siempre.

## 2026-07-30 — rollback (T-034)

- La semántica que importa: el rollback APPENDEA — v3 nace como copia
  del snapshot de v1, la historia nunca se reescribe. El test verifica
  que latest tras el rollback lleva el DAG de la versión 1 (dos nodos),
  no el de la 2.
- Los cuatro guards de la fuente en orden: ids requeridos, padre activo
  (el tombstone es not-found para escrituras también — mismo comentario
  del código Node), fuente org+workflow-scoped, y DAG malformado en 422.
  El patrón core+dos-wires de T-032 hizo esta ruta casi gratis.

## 2026-07-30 — HITO F1: el web real contra Go (T-035)

- El momento que F1 existía para producir: el React de producción,
  sin tocar una línea suya, apuntado a Go por UNA variable de entorno —
  monta, lee, renderiza runs reales, cuenta el approval en espera, y
  ningún panel revienta. Smoke Playwright reproducible en una orden.
- El gap que el inventario estático NO podía ver: /auth/context. El web
  lo llama antes que nada y deriva de ahí los PERMISOS que gatean cada
  lectura — sin la ruta, el síntoma es engañosamente benigno (app
  montada, feed vacío, consola limpia). Perseguirlo requirió leer la
  cadena useBootstrapData → permissionsRef → App → identityContext.
  La rama dev-headers de Node (org sintética admin con las 41 claves
  del catálogo) era la respuesta exacta.

## 2026-07-30 — tool registry + nodo tool (T-036)

- La familia json portada con una decisión que me gustó razonar: los
  guards de prototype-pollution NO son necesarios en Go (no hay
  prototipo que envenenar) pero se portan igual — un payload producido
  por el pilot puede terminar consumido por el backend Node, así que
  refutar `__proto__` en los paths de set y saltarlo en merge mantiene
  la seguridad de la cadena completa, no solo de este proceso.
- El envelope {tool, result} importa más de lo que parece: los
  templates downstream leen A TRAVÉS de él
  ({{context.parse.output.result.value.customer.id}}), y el test lo
  recorre entero. resultPolicy decide si un fallo de tool mata el nodo
  o fluye como dato para que el workflow ramifique.

## 2026-07-30 — parallel_fork + join (T-037)

- El par que valida la tesis de T-005 una vez más: fan-out es tener
  varias aristas salientes, "esperar todas las ramas" es el ALL-AND que
  ya existía, y el claim único del join es el pending→queued atómico de
  siempre. Los executors son cáscaras: validar declaraciones y dar
  forma a outputs. Cero primitivas nuevas de runtime.
- Lo que el par SÍ aporta es intención: el join entrega
  output.branches.{pricing,inventory} — downstream lee por etiqueta,
  no por id de nodo. El test lo recorre con un template que suma por
  label.
- La semántica de fallo salió gratis y el test lo clava: una rama
  fallida rompe el ALL-AND, el join queda pending PARA SIEMPRE y el
  run rueda a failed. "One branch failing fails the whole join" sin
  una línea de código dedicada.

## 2026-07-30 — loop modo map (T-038)

- El día en que el diseño de T-006 cobró su dividendo más limpio: los
  deferredRoots item/index que porté "porque la fuente los tenía" son
  exactamente lo que el loop necesita — el dispatcher difiere esos
  roots en el render de config y el executor los liga por iteración.
  Cero cambios a la gramática.
- Dos seams nuevos en los executors (Emit y ReportUnresolved) para que
  el loop pueda emitir su loop.completed y devolver los paths late-
  bound a la política del dispatcher sin tocar persistencia — los
  executors siguen puros.
- for_each queda honesto: falla con "not executable yet" en vez de
  ejecutar a medias — su maquinaria (tool por ítem, presupuestos de
  fallo, semántica write-side) merece su propio ticket.

## 2026-07-30 — validación de condiciones de arista en save (T-039)

- El ticket más corto de la ola y el más tranquilizador: la estructura
  ya existía completa (el seam inyectable de T-003, la gramática de
  T-006, el saveCore de T-032) — solo faltaba PROBARLO de punta a
  punta. Tres tests nuevos confirman: rechazo con mensaje verbatim y
  edge id sintético, operadores de palabra legales, y violaciones de
  contrato de operadores cazadas estáticamente en save en vez de
  degradar a falsedad silenciosa en runtime.

## 2026-07-30 — ingest de webhooks (T-040)

- `POST /v1/webhooks/{workflowId}` con el contrato de la referencia
  adaptado al alcance del pilot: payload normalizado validado, ancla de
  replay en `trigger_events` ANTES del run, idempotencia sobre
  `(org, dedupe_key)` para que el retry del relay converja a un solo
  run, buffer-on-pause con 202, y el claim CAS dentro de la transacción
  de start — la parte que más valía la pena portar exacta, porque es la
  que hace imposible el doble run bajo entrega concurrente.
- El executor `webhook_received` es passthrough puro (config re-validada
  como última línea de defensa, `{triggeredBy, triggeredAt, event}`);
  el start manual sigue corriendo con evento vacío, igual que Node.
- Hallazgo de encoder: `writeVersioned` fijaba 200 en todo éxito; el
  202 de buffered lo destapó. Éxitos no-200 ahora conservan su status.

## 2026-07-30 — F11: trigger e2e con paridad real + stack de captura aislado (T-041)

- F11 prueba la cadena trigger completa (save → ingest → executor →
  template downstream → outputs de workflow) contra AMBOS backends con
  la misma proyección; el golden vino del stack Node real y confirma
  que los tipos del evento sobreviven el pipeline (`total: 99.5`
  numérico de punta a punta). Paridad Go byte-igual, ×3.
- Incidente y arreglo estructural: lanzar `pnpm dev` desde el worktree
  colisionó por nombre de proyecto Compose (derivado del directorio) y
  tumbó el Postgres del pilot mientras un `run-e2e` de otra sesión
  poseía el lock y :3001 legítimamente. El volumen sobrevivió y la DB
  se restauró, pero la lección quedó codificada: la captura de goldens
  ahora tiene su propio stack (`run-reference-stack.mjs` + compose
  `janusly-goldens`, puertos 4732/4733/3101) fuera del lock compartido
  y de toda DB viva. Nunca más una captura compite con dev/e2e.
- Segundo hallazgo: ids de workflow estáticos en fixtures con estado
  almacenado dejan residuo global entre ejecuciones — `{{RUN}}` los
  hace únicos por corrida en ambos drivers.

## 2026-07-30 — cierre contable de T-003 y T-004

- Auditoría del goal destapó dos `partial` obsoletos de la ola 1. La
  evidencia real estaba completa y verde (los tests de aceptación de
  ambos corren en la suite), así que el cierre fue puro estado — sin
  código nuevo. La regla que queda: al terminar un ticket, el estado
  del plan se voltea en el MISMO commit que el código.

## 2026-07-30 — gate de production-mode + badge de readiness (T-042)

- Las 8 reglas por nodo del gate determinista portadas en el orden de la
  referencia con mensajes y sugerencias verbatim (una aserción pin-ea el
  texto completo de `external_node_missing_retry` para cazar drift). La
  distinción que más importaba portar bien: el retry solo es requisito en
  llamadas READ-side — un write pudo comprometer antes de fallar, y el
  runtime suprime deliberadamente los reintentos ciegos ahí.
- El regex de claves secretas se reutilizó de `grammar.IsSensitiveKey`
  en vez de duplicarse (la misma regla anti-bifurcación que la
  referencia se impone entre safe-persist y workflow-diff).
- El rechazo del start en producción es 422 sin lista de issues — igual
  que Node: el detalle vive en el badge (`/workflows/readiness`, ambos
  wires), no en el error del start.

## 2026-07-30 — bounds HTTP por tenant vía org_configs (T-043)

- La cadena de precedencia del catálogo portada exacta y probada capa
  por capa: config del nodo → fila del tenant → env → default, con los
  mínimos del catálogo y fall-through en valores inválidos (nunca
  medio-aplicar). El caso sutil: `maxRedirects: 0` es un valor VÁLIDO
  de tenant (min 0 — apagar redirects es legítimo) y un `>= min` mal
  escrito lo habría tragado.
- Integración real: un org con `http.timeoutMs = 50` en org_configs
  corta una upstream de 300ms ("timed out after 50ms" en error_json)
  mientras el org vecino sin fila usa el default y termina bien —
  aislamiento por tenant demostrado en la misma corrida.
- `ClaimedNode` ahora lleva el org del run (se puebla del row ya
  cargado en executeClaim), así que la resolución por tenant no añade
  lecturas del run.

## 2026-07-30 — firma de error + clusters de fallos (T-044)

- El normalizador es LA clave de agrupación cross-backend, así que se
  portó regla por regla con sus regexes; la conversión a RE2 se razonó
  en vez de copiarse: los lookaheads de frontera son redundantes en
  cuerpos greedy abiertos, y solo las formas de longitud fija (AWS
  AKIA, Google AIza) necesitan la emulación con grupo de cola. Un test
  pin-ea la frontera ("AKIA + 17 mayúsculas NO es una key").
- Hallazgo upstream (chip creado): en la referencia, un tool llamado
  `json.parse` con input inválido clusteriza como `parse_error`
  genérico — el patrón de la regla 5 matchea el nombre del tool antes
  de que la regla de tool-input corra. El pilot reproduce el mismo
  resultado deliberadamente: paridad primero, el fix pertenece a Node.
- La integración confirma el dedupe con datos reales: un run fallido
  emite muestra por AMBAS superficies (run_nodes + dead_letters) y el
  cluster reporta frecuencia 1 con la ref DLQ ganando, mientras
  `totalSamples: 2` conserva la contabilidad cruda como Node.

## 2026-07-30 — campañas de replay paced sobre el due-clock (T-045)

- La arquitectura del pilot resultó MÁS simple que la de la referencia
  sin perder ningún invariante: Node espeja despachos en BullMQ y
  necesita un reconciliador para publicaciones perdidas; el pilot
  bombea directamente el due-clock de Postgres que Node ya declaraba
  autoritativo. El claim de despacho avanza el reloj por su propio
  pacing en el mismo statement con SKIP LOCKED — doble despacho
  imposible por construcción, cero maquinaria de reparación.
- El test de re-elegibilidad destapó un gap real del F0: el redrive
  reclamaba la fila sin voltear su status, dejando dead letters
  reproducidos como "open" eternos — una segunda campaña los habría
  aceptado como cohorte (el claim habría fallado los items, pero la UX
  del preview mentía). El claim ahora es también el flip open →
  replayed, un solo statement.
- Ciclo completo probado en vivo: cohorte de 2 con 1s de pacing drena
  y completa con contadores exactos; con 60s de pacing la cancelación
  aterriza antes del segundo item y reporta verazmente lo que alcanzó
  a pasar (replayed + cancelled == total).

## 2026-07-30 — paridad ampliada F12-F17 (T-046)

- Seis fixtures nuevos cubren las áreas que faltaban del runtime:
  cancelación en waiting, fork/join etiquetado, loop en sus dos formas
  de items, ruteo por operadores de palabra en aristas, y strict
  template policy hasta el DLQ. Capturados del stack aislado y verdes
  en Go byte-igual al primer intento — la señal más clara hasta ahora
  de que la fidelidad acumulada del port es real: proyección de loop,
  shape del join, cancelación de pendientes y el DLQ de strict policy
  coinciden sin una sola divergencia nueva.
- 18 fixtures totales; keyset se traslada a T-058 donde el round-trip
  de cursores Node↔Go es el objeto del test.

## 2026-07-31 — floor Postgres 15 + strip de credenciales en redirects (T-047, T-049)

- El lane pg15 pagó su costo el primer día: destapó que `make migrate`
  nunca aplicaba la migración propia del pilot (la DB dev la tenía a
  mano) — en una instalación fresca los timers y retries no agendaban.
  El síntoma fue elocuente: F17 colgado 30s y la paridad tardando 541s
  en vez de 4. Con el fix, las 13 suites corren verdes bajo PG 15 sin
  tocar una línea de SQL: el floor es real, no aspiracional.
- También cazó una race de test legítima: los contadores del cancel de
  campañas se leían antes de que el item en vuelo asentara — pg15 solo
  cambió el timing suficiente para exponerla.
- T-049: Go stdlib hace strip de credenciales por DOMINIO y omite
  Proxy-Authorization; la referencia (spec fetch) lo hace por ORIGEN.
  El delta era explotable: mismo host en otro puerto, downgrade de
  scheme o salto de subdominio conservaban el header. El strip por
  origen vive ahora en el mismo CheckRedirect que ya revalidaba SSRF
  por salto, con el caso "mismo host, otro puerto" pin-eado en test.

## 2026-07-31 — bench de regresión con k6 + el índice que faltaba (T-048)

- `make bench` corre los tres escenarios canónicos en secuencia con k6
  y deja dos artefactos: la serie temporal cruda y una tabla que
  cualquiera puede leer — cada métrica declara su dirección (↑ mejor /
  ↓ mejor) y el veredicto ya la aplica, con la nota de ruido esperada
  entre corridas consecutivas.
- El bench se ganó el sueldo de inmediato, dos veces. Primero: los
  números de lista del loadgen estaban inflados — cada invocación
  estrenaba un org vacío, así que "17k req/s" listaba cero filas; con
  un org poblado la verdad era 338 req/s a 150ms. Segundo: la causa
  raíz es compartida con Node — el keyset ordena por (created_at, id)
  pero el índice no lleva el tiebreaker, así que cada página ordena
  todos los runs del org. Con el índice alineado: 17× por consulta,
  24× en el escenario (8.2k req/s @ 8ms sobre org poblado). Chip
  upstream con el patrón two-file para el fix en drizzle.

## 2026-07-31 — corte de mitad de ola: estado y divergencias vivas (T-050)

Doce tickets ejecutados de los treinta del goal (T-041, cierres T-003/
T-004, T-042..T-049 con T-046 adelantado). El registro §9 acumula 146
filas; esta revisión separa lo VIVO — lo que una decisión de F2 o de
producción necesita saber — de lo ya resuelto o informativo.

### Divergencias vivas (estado de comportamiento, no hallazgos puntuales)

**Superficie de ingest/trigger**
- Selector webhook acotado al workflow de la URL (`/v1/webhooks/{id}`)
  en vez del resolver org-wide por endpointKey de Node.
- Eventos `buffered` por pausa no tienen backfill-on-resume en el pilot;
  quedan drenables por el backend Node sobre la misma tabla.
- Sin rate-limit por trigger (storm guard) ni rollouts baseline/canary.

**Runtime**
- Redrive avanza `attempts` (rastro de evidencia) donde Node re-arma en
  1; el evento `node.redriven` es pilot-propio (F05 divergencia aceptada).
- Semántica de método en redirects es la de Go stdlib (301/302 reescriben
  todo no-GET/HEAD a GET; fetch solo POST). El strip de credenciales sí
  es por origen, igual que Node.
- Tipos de nodo ejecutables: el subconjunto pilot (sin `ai`, `agent`,
  `mcp_tool`, `subworkflow`, `schedule`, `email_received`, etc.).

**Plataforma**
- Sin audit rows en ninguna mutación (transversal); sin guardMcpWrite en
  campañas (llega con T-057).
- Org-config: solo el subset http; resolución por ejecución de nodo http
  sin caché de snapshot (revisar si el bench lo señala).
- Clusters: `recurredAfterRecovery` siempre false (sin substrato de
  impacto); muestras cap 2000 por superficie.
- SSE sin cap `streamMaxSubscriptions`.
- `go_pilot_runs_org_created_id_idx` es mejora local pilot-owned; el fix
  upstream viaja por chip con el patrón two-file.

### Hallazgos regalados al backend Node (chips abiertos)
1. Límite de grupos con paréntesis en la gramática de expresiones.
2. Riesgo de run atascado por orden de declaración en el readiness scan.
3. `json.parse` mal clusterizado como parse_error por prioridad de reglas.
4. Índice keyset de runs sin tiebreaker `id` (O(runs-del-org) por página).

### Deuda de proceso saldada en esta ola
- El estado del plan se voltea en el mismo commit que el código.
- Capturas de goldens solo vía el stack aislado (nunca pnpm dev/e2e).
- Integración multi-paquete siempre con `-p 1`.
- `make migrate` aplica TAMBIÉN la migración del pilot (gap de
  instalación fresca cerrado).

## 2026-07-31 — streaming HTTP con preview acotado (T-051)

- El contrato de la referencia portado entero: preview con clamp del
  catálogo, contabilidad de todos los bytes aunque solo se bufferice el
  preview, el cap de respuesta abortando a mitad de stream con el
  mensaje exacto, y la regla de nunca JSON-proyectar un preview. La
  ironía agradable: en Go no existe "modo stream" mecánico — el body
  siempre es un Reader — así que el opt-in solo cambia qué se bufferiza
  y qué se proyecta, sin rama de transporte aparte.

## 2026-07-31 — familia CSV con fetch streaming (T-052)

- El parser es el mismo autómata de la referencia, con sus dos estados
  de frontera (pendingQuote, pendingCr) que hacen posible que una
  comilla escapada o un CRLF caigan partidos entre chunks. El test más
  valioso barre TODOS los cortes posibles de un documento con escapes
  y CRLF y exige idéntico resultado — si el estado cruzado de chunks
  tuviera un agujero, algún corte lo encontraría.
- Observación de diseño: en Go no hizo falta decodificador incremental
  de UTF-8 — los delimitadores son ASCII y los bytes de continuación
  UTF-8 son ≥ 0x80, así que tokenizar por bytes reensambla runas
  partidas gratis.
- `csv.fetch` vive en executors (donde está el SSRF/pinning) y se
  registra sobre el registry base vía el seam nuevo; el catálogo del
  API y el dispatcher consumen el MISMO constructor para que las
  superficies no puedan divergir.

## 2026-07-31 — sweep de retención para tombstones (T-053)

- La cascada dura diferida portada con la misma CTE atómica: la familia
  completa (workflow + versiones + metadata) se purga junta o no se
  purga. Ventana única global de 30 días — el barrido por tenant con
  ventana de catálogo queda para cuando el pilot tenga el catálogo
  completo. El test siembra tres estados (expirado, fresco, activo) y
  verifica que solo el expirado cae con sus dos versiones.

## 2026-07-31 — drenaje justo de timers masivos (T-054)

- El caso que motiva el ticket: una ventana de caída deja miles de
  timers vencidos y el sweep de 50-por-tick tardaría una eternidad,
  con el agravante de que un run acaparador podía llenar cada lote. La
  equidad vive en SQL — round-robin por run vía window function, así el
  primer timer de cada run entra al lote antes que el segundo de
  cualquiera — y el drenaje continúa por lotes hasta vaciar o gastar
  el presupuesto del tick. Los conflictos de resume cuentan como
  progreso (otro actor encogió el backlog); cero progreso corta el
  tick en vez de girar sobre fallos persistentes.

## 2026-07-31 — north star: verifiedRecovery p50/p90 (T-055)

- La métrica de valor del producto medida sobre recuperaciones reales,
  no sobre iniciaciones: solo cuenta un dead letter cuyo replay fue
  reclamado Y cuyo run llegó a succeeded después. La duración va de la
  detección (fila DLQ) a la verificación (evento run.succeeded), con
  percentile_cont en SQL — la misma semántica de percentil que usa la
  referencia. Sin muestra, la respuesta dice null, nunca cero fingido.

## 2026-07-31 — MCP: tools de lista con paginación keyset (T-056)

- runs.list y workflows.list completan el lado de inspección del
  servidor MCP reutilizando las mismas queries keyset del API — mismos
  aggregates, mismo contrato de cursor, cursor malformado degradando a
  página uno en vez de romper la sesión del agente. El test recorre la
  paginación real: página de 2 con hasMore y cursor, página siguiente
  sin solapamiento, filtro por workflow devolviendo exactamente su run.

## 2026-07-31 — consent de escrituras MCP (T-057)

- El principio de la referencia intacto: un agente externo NO escribe
  sin doble opt-in explícito — proceso y tenant — y la negación le dice
  exactamente cuál capa falta, con los mensajes verbatim. El escalón
  completo probado en vivo: flag de proceso apagado, flag encendido con
  consent revocado, y los reads fluyendo sin gate en ambos estados.

## 2026-07-31 — paridad exacta de cursores de eventos (T-058)

- El ticket parecía un test y resultó dos arreglos. Primero, precisión:
  los cursores JS son milisegundos por naturaleza (Date) y Go escribía
  microsegundos — en la frontera exacta de página, el tuple del keyset
  puede saltarse eventos del mismo milisegundo. Ahora todo run_event se
  estampa truncado a ms y el cursor se acuña en el shape exacto de
  toISOString: comparación exacta en ambas direcciones.
- Segundo, orden: Go servía la página DESC cruda; la referencia la
  invierte a ascendente con el cursor apuntando al evento más viejo.
  La divergencia vivía desde F0 porque la proyección de paridad no
  compara eventos — el round-trip la destapó en su primera corrida.

## 2026-07-31 — filtros server-side del DLQ (T-063)

- status/nodeId/workflowId filtran en SQL con la validación de la
  referencia: un status fuera del enum es un 400 con el mensaje
  verbatim, no una página vacía silenciosa. El filtro por workflow
  reutiliza el patrón del fallback ad-hoc del listado de runs, así los
  workflows sin guardar también filtran. severity/sort/owner/search
  (que en Node viven sobre el read-model de la recovery queue) quedan
  fuera del alcance del pilot, anotados.

## 2026-07-31 — Idempotency-Key opcional en /start (T-059)

- Mejora pilot-propia sobre la referencia: un cliente que reintenta un
  deploy o un POST tras timeout de red no duplica el run. La clave se
  reclama dentro de la misma transacción del start — el patrón del
  trigger-claim, invertido — y el duplicado responde con el run
  original en un cuerpo indistinguible: idempotencia de verdad, no un
  409 que obliga al cliente a reconciliar.

## 2026-07-31 — fuzzing de las gramáticas (T-061)

- Once millones de entradas hostiles entre las dos gramáticas sin un
  pánico ni una violación de propiedad. Las propiedades importan más
  que el volumen: lo que valida limpio no puede sorprender al evaluar
  (el acuerdo validar↔evaluar es exactamente lo que el gate de save
  promete), y el rendering lenient es total — cualquier sintaxis de
  template renderiza o degrada, nunca revienta. El corpus semilla
  cubre cada operador, los word-operators, unicode y los rotos
  clásicos (paréntesis sin cerrar, strings sin terminar, NULs).

## 2026-07-31 — property tests del queue (T-062)

- Veinticinco DAGs aleatorios con fan-in natural bajo seis workers, y
  los cuatro invariantes fundacionales verificados directamente contra
  la base: exactamente-una-vez, orden causal por aristas, cero
  huérfanos, contabilidad terminal exacta. Los shapes aleatorios
  complementan los race tests dirigidos del F0 — estos encuentran las
  formas que nadie pensó dibujar. Seeds fijos: un fallo se reproduce
  con su número.

## 2026-07-31 — runbook de operación (T-060)

- El argumento operacional del pilot puesto por escrito: un binario,
  una base, y por tanto una copia de seguridad que ES la copia del
  sistema. La tabla de diagnóstico no es genérica — cada síntoma viene
  de algo que esta ola realmente rompió y arregló (la migración del
  pilot ausente, el escalón de consent, el índice keyset).

## 2026-07-31 — el loop del operador desde la UI real (T-064, T-065)

- El smoke que más dice del F1: la app React de producción, sin tocar,
  ejecuta el ciclo completo de recuperación contra Go — el run falla,
  el operador abre el panel, sana el upstream, pulsa redrive, y ve al
  nodo fallido desaparecer; luego aprueba un gate y ve al workflow
  fluir. Cero errores de página en todo el recorrido.
- Para que el botón funcionara hubo que darle al pilot el adapter
  `/runs/redrive` (el web no llama `/dlq/replay` desde el panel):
  revive-in-place devolviendo el mismo runId, donde la referencia
  crea una continuación de replay — el web reabre lo que llegue.
- Cartografía útil del feed: un run fallido emite dos filas (run y
  recovery — la recovery abre el drawer de evidencia, no el panel), y
  los workflows ad-hoc salen como "Unnamed workflow".

## 2026-07-31 — consolidación: recaptura total + paridad ×3 (T-066)

- La afirmación más fuerte que puede hacer el lane: los 18 goldens
  recapturados del stack aislado en una sola corrida salieron
  byte-idénticos a los committeados — la captura es reproducible y el
  pin no derivó — y la paridad Go corre verde tres veces contra ellos.
- El booter escondía una trampa que solo la recaptura total pisó: sin
  ALLOW_PRIVATE_HTTP_TARGETS el guard SSRF de Node bloqueaba el stub
  loopback y los fixtures http capturaban un fallo distinto al
  original. Las capturas parciales previas no tenían fixtures http y
  nunca lo notaron. La lección de siempre: los caminos que no se
  ejercitan completos guardan sorpresas.

## 2026-07-31 — números de la ola 2 (T-067)

- La pregunta del retest era si una ola entera de features (gate,
  bounds por tenant, timestamps ms, streaming, idempotencia) le costó
  rendimiento al runtime. Respuesta: no — throughput arriba en los
  tres escenarios respecto a F0, y la cola p99 del start compactada
  3.7×. La tabla de evolución declara la dirección de cada métrica y
  sus asteriscos metodológicos en vez de esconderlos: la lista de ola
  2 mide el peor caso (org con decenas de miles de runs) y aún así
  gana, y la comparación diamond es conservadora a favor de Node.

## 2026-07-31 — informe de ola 2: goal completo (T-068)

- Treinta de treinta. El informe dice lo que un lector con poder de
  decisión necesita: qué es el pilot hoy (la app de producción no sabe
  que habla con Go), qué evidencia pesa (paridad reproducible,
  rendimiento sin regresión, el loop del operador entero), qué le
  falta para producción (plataforma, no runtime) y qué ola seguiría.

## 2026-07-31 — plan de las olas 3-6: 119 tickets (T-069..T-187)

- El faltante completo de la migración, analizado y convertido en plan
  ejecutable con el mismo protocolo: ola 3 «plataforma mínima creíble»
  (auth real de 4 modos, audit transaccional con retrofit total,
  limiter en Postgres fail-open, catálogo completo de org config, HA a
  dos instancias, contrato v1 generado); ola 4 «AI + agentes» (el
  chokepoint con su contrato de fallback sagrado, free_json, las dos
  superficies de generación, memoria pgvector con consent, agent loop
  con ambos planners, cliente MCP, human_form con HMAC); ola 5
  «recovery avanzado + rollouts» (cases + receipts, autonomía 0-4,
  sandbox replay, breaker con backfill de buffered, impacto ligado a
  generación, los read-models del web experto, rollouts con rollback
  automático); ola 6 «integraciones + scheduler + subworkflows +
  listo-para-cutover» (Secret Store envelope, chokepoint de
  integration-tools, PagerDuty/Slack/email, db tools, for_each,
  subworkflow con su coreografía transaccional, schedule sobre el
  due-clock probado, y el bloque terminal de cutover: strangler +
  shadow, HA final, seguridad, SDK Python, go/no-go).
- Tres decisiones de arquitectura quedaron RESUELTAS en el plan en vez
  de abiertas: limiter en Postgres (coherente con la tesis), drizzle
  sigue siendo dueño del esquema durante las olas (objetos go_pilot_*
  idempotentes), y el linaje de replay Node-parity se decide leyendo el
  uso real en T-135 (cerrando o re-aceptando la divergencia F05).
- Deuda de la ola 2 saldada dentro del plan: cada gap documentado en §9
  tiene ticket dueño (readiness de credenciales → T-161, /dlq/queue →
  T-143, storm-guard → T-085, backfill de buffered → T-138, audit
  transversal → T-081).
- De paso: quince filas de la ola 2 seguían en `todo` por patrones de
  reemplazo con la prioridad equivocada — corregidas a `done` (todas
  estaban ejecutadas y committeadas); el REPORT-W2 ahora dice 69/69.

## 2026-07-31 — goose: el esquema es del binario (T-188)

- La decisión del usuario ejecutada el mismo día: goose (Go puro, cero
  dependencias pesadas) con las migraciones embebidas — `janusly-go
  migrate` y no hay más ceremonia. El baseline es el dump completo al
  pin, y costó tres saneos que ahora están documentados en el propio
  archivo: los meta-comandos psql del dump de PG18, el reset de
  search_path que rompía la contabilidad de goose, y un SET de PG17+
  que el floor 15 rechaza.
- La prueba de fuego fue doble: una base FRESCA provisionada solo por
  goose corre la suite completa (74 tablas idénticas a la dev), y el
  lane pg15 entero pasa por el camino nuevo. De regalo cayó un bug
  latente: el probe de arranque del F0 preguntaba por FILAS de drizzle
  y habría rechazado toda base goose-provisionada.
- Frontera clara con Node: drizzle sigue mandando en develop; el pilot
  espeja sus migraciones nuevas en cada sync, y una base goose jamás
  corre pnpm migrate.

## 2026-07-31 — la cadena de proveedores de identidad (T-069)

- La arquitectura de auth.ts portada con sus invariantes intactos: el
  primero de la cadena que produce un principal gana, el principal es
  privado del paquete (los handlers jamás ven claims crudos del
  proveedor), y el grant es la fila org_members — el hint del header o
  del claim solo selecciona en cuál de MIS orgs trabajo. Los detalles
  de seguridad que no se negocian: compare en tiempo constante para el
  service token, un Bearer inválido nunca cae en cascada al siguiente
  proveedor, y un browser no puede auto-declararse MCP.
- Supabase se verifica con una llamada HTTP directa al Auth API — es
  exactamente lo que el SDK de Node hace por dentro, sin arrastrar un
  SDK. De paso el 401 del pilot adoptó la forma real del dispatcher
  Node; la nuestra era inventada.

## 2026-07-31 — modo Supabase de punta a punta (T-070)

- El caso de seguridad central quedó probado con datos reales: un
  usuario que EXISTE en dos orgs no entra a un tercero por mucho hint
  que mande — el hint selecciona, la fila org_members autoriza. Y el
  hint-less ambiguo (dos membresías) obliga al cliente a declarar org,
  exactamente como la referencia.
- El backfill perezoso de huérfanos legacy funciona como cuenta la
  fuente: la fila sembrada con el email como placeholder se reescribe
  al UUID real en el primer sign-in y el rol viaja intacto.
- El end-to-end por el middleware usa un Supabase falso vía env — el
  mismo binario, la misma cadena, un JWT válido lee el API y uno
  forjado recibe el 401 con la forma exacta del dispatcher Node.

## 2026-07-31 — la escalera de rol y sus tres sutilezas (T-071)

- Lo que hacía a este ticket un ticket y no una línea: el auto-grant
  admin de dev-headers existe SOLO cuando no hay fila — un viewer
  sembrado sigue siendo viewer aunque entre por dev-headers, y esa
  distinción es la que evita que el modo de desarrollo esconda bugs de
  autorización. Service-token jamás auto-eleva, y un rol custom cuya
  definición fue borrada falla cerrado en todos los modos.

## 2026-07-31 — el catálogo cerrado y su primer gate (T-072)

- Las 41 claves no se transcribieron: se EXTRAJERON con regex de la
  fuente y el test ancla el conteo, las categorías y nueve filas de la
  matriz — si Node añade una clave, la paridad truena aquí en vez de
  derivar en silencio. El primer gate real (save exige editor) probó la
  sutileza de T-071 por el camino HTTP completo: el viewer sembrado
  recibe el 403 verbatim y el fantasma del mismo org pasa por el
  auto-grant de dev.

## 2026-07-31 — el registry anotado con enforcement central (T-073)

- La pieza estructural de la ola: en vez de envolver handler por handler,
  el middleware consulta el patrón matcheado del mux (Request.Pattern)
  contra UNA tabla anotada con los pares exactos de Node — un mount
  nuevo no puede olvidar sus gates porque el gate no vive en el mount.
  El sweep de completitud recorre la tabla entera con un viewer
  sembrado: cada mutación rechaza con el 403 verbatim y cada lectura
  cruza ambas capas, distinguiendo por código los 403 del dominio (el
  runs_forbidden del contrato de runs desconocidos) de los del gate.
- Dos correcciones de datos que el ticket dejó: GET /org/config es
  solo-auth (mi extracción se contaminó con la fila POST) y /resume
  exige runs.start, no runs.write. El smoke web completo sigue verde
  con los gates activos.

## 2026-07-31 — roles custom con la semántica de reemplazo (T-074)

- El matiz que importaba: un override con grants no-nulos REEMPLAZA el
  set default — el auditor custom con dos claves tiene exactamente dos
  claves, no viewer-más-dos. Y el reemplazo aplica también a built-ins
  sobreescritos: un org puede estrechar editor a solo-lecturas. El
  fail-closed cubre las tres grietas: fila borrada, herencia fuera del
  enum, y el custom con permisos null que solo puede ser un bug de
  integridad.

## 2026-07-31 — el piso anti-lockout (T-075)

- Corto y con filo: un admin no puede quitarse a sí mismo la capacidad
  de administrar permisos y miembros — el override del admin built-in
  fuerza las dos claves y reporta cuáles coercionó para el audit. La
  excepción es deliberada: un rol custom que HEREDA rango admin no se
  toca, porque un billing-admin estrecho es un caso de uso, no un
  accidente.

## 2026-07-31 — el chokepoint de audit, con su hallazgo (T-079, T-080)

- La extracción mecánica volvió a pagar: mi primer corte del union type
  dio 88 acciones y el catálogo real tiene 147 — un punto y coma
  intermedio truncó el tipo. Los tests con nombres reales lo
  destaparon de inmediato; una transcripción a mano habría derivado en
  silencio.
- Las dos posturas de escritura quedaron nítidas y probadas: la
  best-effort traga fallos (la telemetría jamás rompe la operación que
  describe) mientras la transaccional EXISTE para fallar — un typo en
  el audit ligado al tx revienta la transacción entera, y la firma del
  handler en Go impone lo que la referencia solo podía pedir por
  convención de nombres. La forense no es falsificable: el bloque
  actor/source derivado del auth gana toda colisión con metadata del
  caller, y las claves sensibles se redactan antes del jsonb.

## 2026-07-31 — las rutas de members y sus dos guards (T-076)

- El guard que importa es el de auto-modificación: un admin no puede
  degradarse ni expulsarse a sí mismo — el candado que evita el org
  irrecuperable — y el intento BLOQUEADO se audita con la intención
  cruda del operador, porque la revisión de seguridad quiere ver tanto
  lo que pasó como lo que se intentó. El otro matiz portado: un cambio
  de rol sobre un no-miembro es 404 sin fila de audit — jamás auditar
  un cambio fantasma que no tocó nada.
- Como estas rutas nacieron DESPUÉS del chokepoint, sus mutaciones van
  transaccionales de cuna — más fuerte que el post-hoc de la
  referencia, y anotado como tal.

## 2026-07-31 — CRUD de roles: el anti-lockout se probó solo (T-077)

- La secuencia del test resultó ser la demostración perfecta del piso:
  tras sobreescribir el admin built-in a una sola clave, el propio
  actor del test (admin por dev) siguió pudiendo revertir el override
  y expulsar miembros — porque el piso le había coercionado
  org.permissions.write y members.write. Si el piso no existiera, el
  test se habría bloqueado a sí mismo a mitad de camino. Nada prueba
  mejor un candado que casi quedarse fuera.

## 2026-07-31 — el binario que rehúsa arrancar mal (T-078)

- Probado con el proceso real, no con un unit: producción sin Supabase
  muere en el arranque con el mensaje exacto de la referencia, y el
  override explícito lo revive. Jamás un fallback anónimo silencioso.

## 2026-07-31 — toda mutación deja huella (T-081)

- Retrofit completo: 18 mutaciones de olas 1-2 auditan con nombres de la
  referencia; el pump de campañas escribe las filas de sistema
  (`system:replay-campaign`) y el MCP server firma `source=mcp`.
- Hallazgo: tres acciones del pump viven FUERA del catálogo tipado de la
  referencia (su system-writer no tipa) — registradas como pilot-action
  sin contaminar el pin de 147.

## 2026-07-31 — el rastro se puede leer (T-082)

- `GET /audit` con el wire crudo de la referencia y keyset exacto; el
  precedente de T-058 (estampar en ms) se extendió al insert de audit,
  cerrando un salto de frontera de página que la referencia aún tiene.

## 2026-07-31 — el chokepoint formal de persistencia (T-083)

- Las 3 capas de safe-persist en `grammar`, con el engine de shim (el
  mismo split de la referencia) y el metadata de audit ganando la cota
  que no tenía. El property test siembra secretos reales y barre las 6
  columnas jsonb: cero supervivencias, snapshot DLQ reproducible.

## 2026-07-31 — el limiter sin Redis (T-084)

- La decisión de arquitectura del operador, ejecutada: ventana fija en
  Postgres con la ventana DENTRO de la PK (un UPSERT O(1) por request),
  fail-open con warn, y el 429 con el mensaje exacto de Node. La
  degradación audita una vez por (bucket, día) — dedupe probado con dos
  réplicas de memoria fresca contra la misma base.

## 2026-07-31 — el limiter en sus tres puertas (T-085)

- Storm-guard por trigger con el orden exacto de Node (received → guard →
  buffer) y el 429 con cuerpo verbatim; MCP writes con bucket por tool a
  60/min. Hallazgo: la card pedía limitar start/save/resume "como Node" —
  y Node no los limita; portar la realidad, no la especulación.

## 2026-07-31 — el catálogo cerrado gobierna (T-086)

- 69 definiciones extraídas mecánicamente (no ~50 como estimaba la card),
  guards verbatim, resolutor por capas puro. El GET que respondía `[]` a
  una org fresca era divergencia: la referencia responde el catálogo
  completo con procedencia por clave.

## 2026-07-31 — el catálogo gobierna de verdad (T-087)

- requireSavedWorkflow con el 403 verbatim; el chequeo saved-vs-adhoc de
  paso corrigió el audit de arranques (guardado → run.started). Retención
  por org probada con dos orgs y ventanas distintas; el consent MCP lee
  del snapshot; /health dejó de fingir salud del limiter.

## 2026-07-31 — la retención que drena sin bloquear (T-088)

- Las tres purgas con el patrón de la referencia (lotes acotados, legal
  hold, shape con `cappedByMaxBatches`), y una lección de rendimiento:
  enumerar orgs por los pisos del catálogo convirtió 40 s de barrido en
  milisegundos — una org sin datos viejos ni entra al loop.

## 2026-07-31 — la tubería de telemetría antes del primer token (T-089)

- El seam de usage con el contrato exacto de la referencia y un Fire que
  absorbe todo (error, pánico, org ausente) — cuando llegue el LlmClient
  en ola 4, la telemetría ya lo espera.

## 2026-07-31 — usage por run y costos acotados (T-090)

- /run/usage real con el agregado de la referencia, y el rollup de
  costos que agrega la ventana completa en Postgres: 100 grupos + una
  fila resto explícita, con la invariante probada de que los totales
  quedan exactos aunque la cardinalidad se pliegue.

## 2026-07-31 — salud en dos niveles (T-091)

- Lo público jamás enseña números vivos (probado por negación de claves)
  y lo admin mide la edad desde la ELEGIBILIDAD — el evento node.queued o
  el wake_at del retry, con la edad desconocida excluida en vez de
  inventada: el mismo matiz que la referencia documenta sobre BullMQ.

## 2026-07-31 — los dashboards no renombran (T-092)

- Los nombres de la referencia scrapean junto a las series propias, el
  Resource viaja como target_info, y el conflicto de bind se probó con
  el binario real: exit no-cero en vez de media superficie.

## 2026-07-31 — la afirmación del REPORT-W2, ahora probada (T-093)

- Dos engines, una base: 75 DAGs, una campaña con dos bombas y 80
  wake-ups de retry — exactly-once aguantó todo, tres corridas. Los dos
  fallos del camino eran del arnés (Edges null; el revive-in-place acuña
  DLQs nuevas), y ambos terminaron documentando comportamiento real.

## 2026-07-31 — ningún singleton implícito sin probar (T-094)

- Los cinco loops de fondo, cada uno con su gemelo simultáneo en el lane
  HA: claims, campañas, timers, reaper y retención. Ninguno necesita
  lease — y el RUNBOOK ahora dice exactamente dónde cortar si algún día
  lo necesitan.

## 2026-07-31 — el contrato que no puede mentir (T-096)

- 20 rutas v1 en un manifiesto sin efectos, renderizadas deterministas a
  OpenAPI 3.1 con el envelope documentado una vez; el guard de deriva se
  probó tocando el manifiesto sin regenerar — y falló como debía.

## 2026-07-31 — el lane Go en el CI real (T-097)

- test_go monta en los triggers existentes con service container directo
  y make ci completo. Y una lección local: el soak y la suite no
  comparten DB — el binario del soak roba claims de los tests. En CI el
  DB es efímero por job; en local, un lane a la vez.

## 2026-07-31 — una hora bajo carga, plano (T-095)

- 121 muestras, tres señales estables: RSS +2.2%, goroutines −4.6%,
  heap +1.8%. El binario entero vive en ~33 MB tras una hora. Dos
  lecciones del arnés: k6 async o el muestreador muere de hambre, y el
  residuo pending de un SIGTERM al soak contamina la suite si no se
  limpia.

## 2026-07-31 — ola 3 cerrada (T-098)

- 31/31. El pilot dejó de ser un runtime con paridad y se volvió una
  plataforma multi-tenant operable con su esquema en propiedad. La
  evidencia que más pesa: dos instancias sin perder exactly-once, cero
  secretos sobreviviendo en jsonb, un candado que casi se cierra sobre
  su propio autor, y una hora de carga en 33 MB planos.

## 2026-07-31 — una sola puerta para todo token (T-099)

- El chokepoint AI con el contrato de fallback viviendo EN la frontera:
  ocho clases de error estables, recover diferido, y un test que camina
  el módulo entero para probar que nadie más importa el SDK.

## 2026-07-31 — el catálogo gobierna los tokens (T-100)

- aiconfig resuelve todo del catálogo por capas; sin clave todo cae
  limpio a no_client, y un tenant configurado a otro proveedor recibe
  fallback en vez de un re-ruteo silencioso a Anthropic.

## 2026-07-31 — cada token deja factura (T-101)

- El chokepoint dispara el recorder en cada intento — éxito con costo
  calculado, fallback con el error clasificado — y las tres posturas de
  costo (desconocido→null, simulado→cero, override de env) probadas
  contra filas reales.

## 2026-07-31 — el breakpoint de cache, anclado al wire (T-102)

- Un servidor de captura probó el request mismo: el bloque system lleva
  el cache_control exacto cuando se opta, ni un byte cuando no, y el
  max_tokens per-call aterriza tal cual.

## 2026-07-31 — la gobernanza que nunca es outage (T-103)

- El gate de presupuesto con las tres zonas (sin límite, warn, block),
  fail-soft ante consultas rotas, y la prueba clave: una llamada
  bloqueada registra cero hits al proveedor.

## 2026-07-31 — el JSON que casi era (T-104)

- La extracción de la referencia 1:1 más la reparación de truncados: un
  prefijo válido cortado a mitad de stream se cierra con conciencia de
  strings y escapes. Mil cadenas de fuzz sin un solo pánico.

## 2026-07-31 — la superficie estrella genera (T-105)

- free_json de punta a punta: prompt verbatim de 21KB, escalera de
  intentos con preservación de referencias del operador, reparación
  dirigida con los issues reales del dominio, y las 5 plantillas $0. La
  aceptación de verdad: los evals de Node corriendo contra Go — 3/3
  deterministas, 27 saltados, exit 0.

## 2026-07-31 — N candidatos, un ganador determinista (T-106)

- Best-of-N con el scorer de la referencia y la regla que importa: un
  candidato inválido no descarta la generación si otro valida, y N=1
  ni siquiera entra a la rama.

## 2026-07-31 — preferencias, jamás órdenes (T-107)

- janusly.md compuesto con el framing DATA de la referencia: el intento
  de "ignora las instrucciones previas" sobrevive solo como líneas de
  datos detrás de la cláusula de escape, los secretos se lavan al
  componer, y la matemática de donación garantiza que la org nunca borra
  la sección del workflow.

## 2026-07-31 — prompts con versión y sin redeploy (T-108)

- El registro portado con su semántica REAL (sirve promptRefs de nodos,
  no el system prompt — la card especulaba); pin de una versión vieja
  cambia el prompt activo en caliente, los ciclos de include se
  rechazan, y una variable requerida ausente falla antes del primer
  token.

## 2026-07-31 — parches que se validan antes de existir (T-109)

- El patch de recovery con sus dos envelopes (config + estructural con
  recableo), la regla de oro probada — un parche inválido jamás llega al
  wire — y las alternativas lavadas con el scrub apilado tras descubrir
  que el compartido no cubría claves sk-ant.

## 2026-07-31 — el "por qué" sin segunda llamada (T-110)

- El canal de evidencia portado con su realidad (respuesta, no
  persistencia): proyección determinista con 6 kinds cerrados, caps en
  runas — la semántica de length de JS, no bytes — y el audit llevando
  solo el conteo.

## 2026-07-31 — el nodo que nunca tumba el run (T-111)

- El executor ai con los cuatro escalones probados: $0 sucede, vivo
  responde, la validación no marca el SDK, y el proveedor muerto deja
  el fallback en el estado — jamás un run fallido por culpa del modelo.

## 2026-07-31 — memoria que pide permiso dos veces (T-112)

- El sustrato pgvector con el consent de dos flags + allowlist de kinds,
  embeddings de Ollama, y la garantía probada de que nada lanza: consent
  apagado escribe cero, Ollama muerto degrada en silencio, y cada
  recall firma su runId para la factura.

## 2026-07-31 — la memoria llega a los workflows (T-113)

- Las vector tools como wrappers finos interceptados en el executor —
  el registro queda puro y la identidad org/run viaja por closures. El
  consent apagado responde envelopes cerrados sin lanzar, y la
  validación salta la escritura con cero filas.

## 2026-07-31 — el agente que observa y no se pasa (T-114)

- El bucle con el planner de reglas verbatim y las tres garantías: el
  presupuesto corta limpio, el dry-run jamás ejecuta un write, y
  http.request viaja por la misma maquinaria guardada del nodo http.

## 2026-07-31 — el planner que nunca deja al agente sin plan (T-115)

- El planner LLM con su matriz completa: cinco formas de fallar y todas
  aterrizan en el plan de reglas con su atribución; el presupuesto
  termina limpio; y el plan válido ejecuta. El bucle siempre avanza.

## 2026-07-31 — el agente que recuerda sin contar (T-116)

- Episodios con recall semántico solo para el planner LLM, short-circuit
  antes del primer embedding con consent off, y el evento que emite
  huellas — jamás contenido. La segunda corrida aprendió de la primera.

## T-117 · multi_agent (2026-07-31)
- `internal/executors/multiagent.go`: crew sobre `runAgentLoop`. Secuencial re-renderiza el goal de cada agente en su turno contra `{context: sharedContext, previousAgents: results}` (root `previousAgents` diferido en dispatch para este tipo de nodo) con el gancho de política estricta (`in.ReportUnresolved`) ANTES de correr el agente; paralelo resuelve todos los configs antes de lanzar goroutines — nunca difiere. `sharedContext` gana `agent_<i+1>` y `<name>` con `{output: result}` tras cada agente completado.
- Agregación textual de la referencia: `last` (finalAnswer/finalResult del último), `all`, `first`, `best-effort` (primer no-fallido). `continueOnError` acumula `{status:"failed", error:{message}}`; sin él, secuencial propaga el error y paralelo falla con `Multi-agent <name> failed: <msg>`.
- Eventos: `multi_agent.started/agent.started/agent.completed/agent.failed/completed`. `PilotNodeTypes` += `multi_agent`; dispatch construye AIDeps+MemoryDeps para el nodo.
- Hallazgo: la referencia SOLO liga tarde el goal — el assert correcto del binding es el goal renderizado del evento `agent.started`, no el config del agente (eso se renderiza en dispatch y conserva el literal).

## T-118 · agent.reasoning (2026-07-31)
- Contrato estable del evento alineado a `packages/shared/src/run-events.ts`: caps por campo 120 (agent) / 160 (scope) / 160 (tool) / 500 (reason) en RUNAS; `sanitizeReasoningText` = ScrubGuidanceSecrets + aplanado de control/bidi/ZWSP/FEFF a espacio + colapso de whitespace + cap; fallbacks "agent"/"unknown"/mensaje por defecto.
- `tool` es null JSON cuando decision=finish; `replacesEventId` apunta al id exacto del `agent.step.planned` que este resumen seguro reemplaza — `executors.Input.Emit` ahora devuelve el id del evento insertado (un solo sitio de asignación en dispatch).
- Tests unitarios en `internal/executors/agent_reasoning_test.go`; suites de agente/multi-agente del engine verdes con `-race`; `boundedText` eliminado (quedó sin usos).

## T-119 · Scopes diferidos + política estricta (2026-07-31)
- Sin producción nueva: `recordUnresolvedPaths` ya era el chokepoint único (render ordinario en dispatch + costura `ReportUnresolved` que usan loop y multi_agent). El ticket agrega la evidencia en el punto real de binding.
- `TestDeferredScopeStrictPolicy`: crew secuencial con `{{previousAgents.5.result.ghost}}` duplicado en el goal del agente 2 — bajo `strict` el run falla DESPUÉS de que el agente 1 completó (evento `agent.completed` presente) con evidencia `policy:strict, count:1`; bajo leniente el run triunfa con UN evento deduplicado.
- `TestLoopItemScopeStrictPolicy`: `{{item.ghost}}` bajo estricta falla por iteración con evidencia `item.*`. La cota (20 paths + truncated) ya estaba probada a nivel grammar.

## T-120 · Nodo mcp_tool cliente (2026-07-31)
- `internal/mcpclient`: chokepoint `Execute` con la escalera de defensas de la referencia en orden (multi-tenant → conexión enabled/active → descriptor → validación subset JSON-Schema → dry-run write-skip → consentimiento dos flags `JANUSLY_MCP_CLIENT_WRITES_ENABLED` + `mcp.clientWriteConsent` → env-refs con error genérico y rechazo CRLF → rate-limit por (alias, tool) fail-open → transporte). Nunca lanza: todo camino termina en `{ok:false, error}` + usage row `mcp.tool_call`.
- Transportes URL (`sse`/`http`): `executors.NewPinnedHTTPClient` valida SSRF ANTES de construir y entrega al go-sdk un `http.Client` cuyo dialer conecta SOLO a la IP validada — rebinding DNS no puede redirigir un fetch/redirect del SDK; los env-refs resueltos viajan como headers.
- Sandbox stdio: allowlist `mcp.clientCommandAllowlist` (fail-closed vacío), env whitelist `{PATH}`+refs, cwd temp fresco por spawn, watchdog de vida y cap de stderr — ambos matan vía cancel de `exec.CommandContext` (os/exec posee el kill; leer `cmd.Process` desde otra goroutine hacía data race con el `Start` del SDK). Tail de stderr redactado con signature+aiguidance apilados.
- Nodo `mcp_tool` fino en executors vía costura `Input.Mcp` (dispatch la construye con dry-run desde `runs.replay_mode`); `!ok` → `mcp_tool failed: …` para el retry/DLQ ordinario. Eventos `mcp_tool.started/completed` + `mcp.sandbox.terminated`.
- Hallazgos: el baseline ya traía ambas tablas y el catálogo orgconfig las claves `mcp.*` (piso de lifetime 60s → costura de test); sin columna cwd ni headers en el esquema por diseño de la referencia.

## T-121 · Descubrimiento MCP + sanitización (2026-07-31)
- `RunDiscovery` reutiliza `dialSession` (mismos transportes endurecidos que la ejecución: pin SSRF, sandbox stdio), lista herramientas (cap 200), upserta descriptores con `enabled=false` + `writeSide=true` (fail-safe: nada corre ni llega a un prompt sin opt-in del admin) y persiste `status` active/failed con razón scrubbed y acotada a 200. Deliberadamente sin transacción (I/O de red).
- `internal/signature/mcp_sanitize.go`: `SanitizeMcpToolDescription` (NFKC → strip del bloque de inyección U+200B–U+200F/U+202A–U+202E/U+2060–U+206F/U+FEFF → control chars a espacio → ScrubSecretShapes → cap 300 runas con elipsis, "(no description)" para vacío) y `SanitizeMcpPromptLabel` (mismo endurecimiento, colapso fuera de [A-Za-z0-9_.-] a `_`, cap 120). Fixtures del test Node portados.
- `ListExposedToolsForAi`: los 4 flags independientes (conexión enabled+exposeToAi, descriptor enabled+exposeToAi), orden estable (alias, name), caps 60 herramientas / 20.000 bytes de prosa, entrada sintética `_truncated` visible para el LLM y el operador. Scrub de guidance apilado al leer.

## T-122 · writeSide de descriptores + readiness (2026-07-31)
- `internal/httpapi/mcp.go`: `POST /mcp/connections` (transporte enum, stdio fail-closed contra `mcp.clientCommandAllowlist`, URL http(s) válida, alias único; triplete create + discovery + audit deliberadamente sin transacción) y `POST /mcp/connections/{alias}/tools/{toolName}` — la ruta con la que el admin marca una herramienta descubierta como read-only, la habilita, la expone al LLM o fija el rate override tri-estado (ausente = conservar, null = limpiar, entero 1..10000 = fijar). Audits solo en cambio real.
- Readiness: `mcp_tool` es write-side POR DEFECTO (el JSON del workflow solo lleva alias+tool; el flag real vive en el descriptor del lado API) — `TestReadinessMcpToolApprovalGate` prueba el issue `sensitive_action_missing_approval` sin ancestro approval y el silencio con él.
- Dry-run split probado por run de validación: descriptor read-only EJECUTA (señal real), write-side SALTA con `{skipped:true}` — exactamente el motivo por el que el marcado read-only del admin importa.

## T-123 · Matriz de fallos AI (2026-07-31)
- `internal/ai/failcat`: el catálogo único de fixtures de fallo (regla del proyecto: un catálogo alimenta todas las suites). 9 casos wire con su clase AIError esperada + 5 réplicas hostiles con su veredicto parseable, más `Handler()`/`SuccessEnvelope()` para servirlos.
- Consumido por 4 suites: el cliente ai (matriz de clasificación — refactor del inline anterior), la escalera free-json (repair-or-fail por réplica), `/ai/generate-workflow` (cada fallo wire degrada con HTTP 200, `mode:"fallback"`, clase aiError al frente y template de fallback con nodos) y el nodo ai por run real (el run TRIUNFA; salida `{mode:fallback, aiError}` — el contrato sagrado).
- Hallazgo: un 200 con cuerpo no-JSON clasifica `network`, no `unknown` — el SDK lo reporta como fallo de decode del transporte (proxy roto delante del proveedor), y esa es la lectura honesta. El caso quedó documentado en el catálogo.
- Agente/embeddings ya tenían sus matrices propias (TestAgentLLMPlannerMatrix, memoria con Ollama muerto); el catálogo cubre las superficies de parseo/proveedor.

## T-124 · Evals contra Go (2026-07-31)
- Corrida formal del harness existente (sin fork): binario Go servido en :4699, `JANUSLY_EVALS_API_URL=http://127.0.0.1:4699 node scripts/run-evals.mjs` → 3 passed / 0 not-passing / 27 skipped / exit 0. El gate `summarizeAi` + `compareToBaseline` corre intacto.
- Deterministas al 100%: los tres casos con template exigido pasan con los ids clavados del T-106. Los 27 casos ai-mode saltan porque el fallback sin key del Go no adjunta `aiError` — exactamente el contrato de skip que las evals esperan (excluidos de denominadores, verde a $0).
- Divergencia explicada y aceptada: la tasa ai-mode contra baseline no se puede medir a $0; la corrida dorada con key real gasta créditos y queda como ítem diferido invocado por el usuario (decisión vigente desde la ola 3).

## T-125 · /validate + planner tools (2026-07-31)
- `POST /validate` + `/v1/validate` (gates {editor, workflows.write}): la forma de la referencia `{valid, issues}` directo de `domain.Validate`, aceptando cuerpo plano o sobre `{workflow}`. Deliberadamente SIN el carve-out del save: /validate reporta la lista completa de issues, incluido `node_type_unsupported_pilot` — validar informa, guardar decide.
- `PlannerTools` ahora carga el `jsonSchema` planner-only (objeto JSON-Schema derivado de la misma tabla de campos); `Catalog()` — lo que sirve `GET /tools` — no lo incluye, así el schema del planner nunca sale por la superficie pública (paridad con listTools() vs proyección privada de la referencia).
- Paridad de códigos probada: `empty_workflow`, `edge_invalid_to`, `input_default_type_mismatch` (gramática recursiva de inputs), `node_type_unsupported_pilot` con `subworkflow` (hallazgo: `code` no está en el vocabulario de plataforma del pilot → `unsupported_node_type`).

## T-126 · human_form + tokens de resume (2026-07-31)
- `internal/resumetoken`: puerto de secrets.ts — HMAC-SHA256 sobre `v1.<base64url(payload)>`, binding (org, run, node, purpose), `issuedAt`+`expiresAt` firmados en emisión (cambiar la política después NO reescribe tokens vivos), TTL 300..604800, legado v1 sin expiresAt con la frontera exacta del verificador original (válido AL séptimo día, expirado un segundo después), error uniforme "Invalid resume token", secreto dedicado `JANUSLY_RESUME_TOKEN_SECRET` (fallback dev; producción sin él rechaza — nunca reusar el service token).
- Executor `human_form`: exige schema objeto no vacío (`human_form_schema_required` — el fallo #1 de generación AI es el schema vacío), pausa con `{kind, schema, fields, title}`; el ENGINE firma el token al persistir el checkpoint waiting (la política TTL y el secreto nunca entran al executor).
- `ResumeRunWithInput`: para human_form exige y verifica el token, valida el input contra el subset JSON-schema del nodo (`domain.ValidateInputValue`) y completa SOLO un nodo aún waiting con el input como output — el CAS existente garantiza que un replay no doble-escribe ni doble-encola. `/resume` mapea las formas Node: 400 `runs_resume_token_required` / 400 `runs_input_validation_failed` / 403 `runs_invalid_resume_token` / 409 `runs_resume_conflict`.
- Carrera probada: dos POST simultáneos con el mismo token → exactamente un 200 y un 409; downstream corre una vez y lee el output del formulario.

## T-127 · Smokes web ola 4 (2026-07-31)
- Dos smokes nuevos contra el web real apuntado a Go: AI Studio ($0: copilot → Draft flow → fallback approval-gate con "Starter flow loaded locally" → Validate → Save → Run → Approve vía fila del run → succeeded) y human form (paso `Collect form` → Run → Fill form → dialog schema-driven con el token firmado → Submit → run continúa). Cero pageerrors en ambos; `run-web-smoke.mjs` 4/4 en dos corridas consecutivas.
- BUG de paridad real cazado por el smoke: `/start` de Go exigía el sobre `{workflow}` mientras el web (igual que contra Node) envía el workflow PLANO al correr sin input — `startCore` ahora acepta ambas formas.
- El runner pre-limpia los 5 ids fijos de los templates de fallback (los ids son fijos también en Node; un save previo de otro org bloquea el siguiente — limitación real del producto, documentada).
- Flakes diagnosticados: un binario de pruebas huérfano compartía la DB y reclamaba jobs con `ALLOW_PRIVATE_HTTP_TARGETS` sin setear (los nodos http del smoke morían con "private and blocked"); la tarjeta de waiting vive en el panel del run — la navegación estable es click a `activity-row-run:<id>`.

## T-128 · REPORT-W4 (2026-07-31)
- Informe de cierre de la ola 4 en go/REPORT-W4.md: paridad de evals en tabla (3/3 deterministas con ids clavados, 27 ai-mode con skip limpio, gate sin fork, exit 0), costo real de la ola $0 en créditos (todo simulador doble-gate o fallback; 2.046 filas llm.completion / 195.704 tokens contados por el ledger real), cinco divergencias AI vivas con su porqué, y la recomendación para la ola 5 (contrato de recovery primero; extender replay_mode y failcat en vez de duplicar; mapear tickets contra lo ya existente en el baseline; presupuestar la corrida dorada).
- Cierre: 30/30 tickets de la ola done; 130/130 acumulados; suite completa verde con -race; lint 0; smoke web 4/4.

## T-129 · recovery_cases + receipts (2026-07-31)
- `internal/domain/recoverycase.go`: puerto puro de recovery-case.ts — los 12 estados en escalera cerrada (mapa legal verbatim, incluidos los rebotes validating/awaiting_approval→candidates_ready y que publishing SOLO abandona), 4 terminales, vocabulario cerrado de evidencia (10 kinds) y validación completa del receipt (actor system/user/agent con id obligatorio para user/agent, evidencia 1..100, sha256 hex64 opcional, reason ≤1000).
- `internal/engine/recoverycases.go`: `CreateRecoveryCase` idempotente (id determinista `sem_<sha256(org,run,detector)>` + ON CONFLICT DO NOTHING sobre el índice único ya existente) y `TransitionRecoveryCase` — validación de dominio ANTES de escribir, CAS `UPDATE ... WHERE state=from`, receipt `sct_<sha256(caseId,toState)>` en la MISMA tx; si el índice único `(case_id, to_state)` rechaza el receipt (re-entrada), el estado se revierte: una transición sin receipt es imposible por construcción. Terminal estampa `resolved_at`.
- Integración probada: salto ilegal no escribe nada; CAS obsoleto → conflicto sin receipt; carrera de dos operadores → exactamente un ganador/un receipt; escalera completa hasta verified_recovered con receipts append-only en orden.
- Hallazgo: tablas + índices únicos ya estaban en el baseline (4ª vez del patrón); la postura single-visit del índice hereda de la referencia (onConflictDoNothing) — un rebote real a candidates_ready chocaría con su receipt previo, divergencia-espejo documentada.

## T-130 · Contratos V1/V2 (2026-07-31)
- `internal/domain/recoverycontract.go`: puerto completo de recovery-contract.ts — vocabularios cerrados (autonomía 0-4, 6 evidencias, 4 kinds de efecto con idempotencia/receipt, 6 clases de repair), validación común (autonomía por fallo ≤ techo, evidencia única con base retenida, un efecto por nodo, `validation_receipt` sobre static, `effect_receipt` para niveles autónomos) y el split Level 4 vs resto (L4 exige provider_simulated/live_canary + autonomous_level_4 + narrowAutonomy con bounds y repairs permitidos, sin efectos no-idempotentes ni receipts manuales; bajo L4 la mutación autónoma y narrowAutonomy se rechazan). Regla dura heredada verbatim: V1 mantiene la semántica DESHABILITADA — modo deterministic o detectores en V1 fallan el parse.
- `Workflow.Recovery` se valida EN `Parse` con issues `invalid_contract` de path `recovery.contract` (paridad con el rechazo del WorkflowSchema.parse de Node). Breaker union `false | 2..100 | {consecutiveFailures}` con `ParseCircuitBreakerThreshold` (insumo de T-138).
- `internal/recovery/semanticoutcomes.go`: evaluador determinista puro (paquete nuevo — usa grammar + domain sin ciclos). Expresiones por la MISMA gramática de aristas sobre el contexto con overlay del output completado; schema por `ValidateInputValue` (detalles cap 50); un error de expresión es violación con detalles, nunca un pass silencioso; `Quarantined` = algún detector quarantine (el más estricto gobierna el veredicto same-source); replay de fixtures con el evaluador exacto del runtime.

## T-131 · Autonomía Level 0-4 (2026-07-31)
- `internal/domain/recoveryautonomy.go`: puerto puro de recovery-autonomy.ts. La escalera de capacidades (observe 0 / recommend 1 / validate 2 / apply_with_approval 3 / autonomous_apply 4) con factores explicables por fila; `ResolveRecoveryAutonomyProfile` resuelve override-por-fallo (técnico por clase, semántico por detector — solo puede bajar el techo; subirlo ya lo veta el validador del contrato de T-130), default del workflow, y falla CERRADO (`unavailable` + razón contract_missing/failure_policy_missing) cuando no hay política — un V1 nunca resuelve autonomía semántica pero sí técnica.
- `CombineRecoveryAutonomyProfiles`: una sustitución cierra cohortes same-source atómicamente, así que el detector MÁS estricto gobierna (min de niveles, fuente strictest_failure); cualquier miembro unavailable envenena el agregado (cerrado, nunca desaparece); ids deduplicados. Cierra la aceptación "mismo-source → estricto" que T-130 dejó pendiente.
- Fixtures del test de la referencia portados, anclando primero que el contrato fixture VALIDA (el validador de T-130 es el gate de entrada).

## T-132 · observe/quarantine + dominancia (2026-07-31)
- Reglas contract-vs-DAG fail-closed en save (`internal/domain/recoverydag.go`): cada fuente quarantine debe DOMINAR todo efecto write-side declarado o real (`canReachNodeWithout`: si alguna raíz alcanza el efecto sin pasar por la fuente, no hay garantía pre-efecto); write-side reales sin declarar fallan; fuentes deferred-completion y routers-para-quarantine rechazados; fixtures calificadas con el evaluador REAL (mismatch, pass faltante, violación específica del detector faltante). `ValidateWithSemanticFixtures` extiende Validate sin romper llamadores; las 5 superficies de producto inyectan `recovery.FixtureOutcomesForValidation`.
- Intercepción runtime en `CompleteNode`: los detectores se evalúan ANTES de la tx sobre el snapshot pre-completación con el output exacto superpuesto; en la tx, observe crea el caso `detected` (sin pausar), quarantine crea el caso `contained` + receipt detected→contained + evento `recovery.semantic_violation` y parquea el run en `waiting` — el gate de negocio cierra ANTES de agendar downstream (la ventana de crash no existe: todo en la misma tx). `outcome_status`/`semantic_violation_count` proyectados al run; el sandbox (`replayMode=validation`) nunca crea casos durables.
- Hallazgo: las columnas de outcome del run ya estaban en el baseline (5ª vez).

## T-133 · Sandbox replay (2026-07-31)
- `executors.Input.DryRun` general: dispatch lo computa UNA vez desde `runs.replay_mode == "validation"` y lo reparte a todos los executors (las costuras AI/MCP/memoria ya lo llevaban por separado — ahora comparten la misma lectura). El nodo `tool` salta cooperativamente CUALQUIER tool write-side del registry; el nodo `http` salta métodos de escritura (no-GET/HEAD/OPTIONS); ambos persisten `{skipped:true, reason:"validation_dry_run"}`.
- `runs.validation_evidence_level = 'static'` se estampa al NACER el run de validación — la escalera del contrato lee esto para decidir qué puede probar el run (static nunca alcanza para autonomía L4). La proyección del run en la API expone las columnas reales de outcome/evidencia en vez de nil fijos.
- Probado por run real: en validación el GET dispara (señal real), el POST salta, la evidencia es static; el MISMO workflow sin replay mode dispara el POST — el gate es el modo, no el workflow. Skip genérico probado con un tool write-side registrado de prueba (email.send llega en ola 6).
- Exclusiones: los sandbox ya no crean casos semánticos (T-132); breaker y métricas verified leerán `replay_mode` (T-136/T-138).

## T-134 · /dlq/validate-fix (2026-07-31)
- `POST /dlq/validate-fix` (+ alias /v1; gates {editor, recovery.write}; rate bucket "ai"): el fix propuesto pasa el MISMO gate de gramática que la salida del patch AI (Parse estricto + validación completa con fixtures; los tipos pilot-unsupported no bloquean el sandbox — el DAG es sano), exige que el nodo fallido siga presente, y siembra la validación vía `engine.ReplayDeadLetterAsValidation`: run fresco del workflow SUGERIDO con el input RESUELTO del run original, `replayMode=validation` (skips de T-133), linaje trace-only `parentLinkKind="replay"` al run fallido y evidencia static de nacimiento.
- `StartInput` ganó `ParentRunID/ParentNodeID/ParentLinkKind` (columnas ya en el baseline) — el sustrato que T-135 reutiliza para el linaje del replay de producción.
- Postura pilot honesta: `validationEffectMode="provider_simulation"` responde 409 unavailable (no hay simulador de efectos en este backend aún) y un `recoveryPlaybookId` responde 409 match_changed hasta que T-139 traiga los playbooks.
- Test: 7 rechazos pre-run + el camino feliz con el delta de writes en 0 (el run original ya había pegado uno — la medida correcta es el incremento), linaje verificado y audit `recovery.validation_started`.

## T-135 · Linaje de replay Node-parity (2026-07-31)
- DECISIÓN (leyendo adapters/dlq-replay.ts de la referencia): el replay de PRODUCCIÓN de Node también es revive-in-place — claim + republicación del nodo fallido en el MISMO run con attempt re-armado a 1; el run de continuación con `parentLinkKind="replay"` existe SOLO para el sandbox de validación. La card asumía otra cosa; la fuente manda.
- F05 CERRADA: `RedriveFailedRunNode` ahora re-arma `attempts=1` (antes +1). La entrada de `acceptedDivergences` se eliminó y la paridad F01-F17 corre verde contra el golden SIN excepción.
- Rama exact-identity de `/dlq/replay`: el panel del run postea `{runId, nodeId}` sin dead-letter id — `RedriveRunNode` (403 cross-org indistinguible, 409 conflicto, mismo re-armado).
- La validación de T-134 subió a la forma de CONTINUACIÓN de la referencia: ancestros copian su contexto terminal del run original (los templates del camino ven los MISMOS outputs upstream), solo el nodo fallido arranca queued (attempt 1), descendientes pending para la cascada ordinaria, el resto skipped con `outside_validation_path`; evento `run.started.validation`.

## T-136 · Impacto terminal generation-bound (2026-07-31)
- Pipeline exacto de la referencia: `RedriveDeadLetter` estampa el claim en `run_nodes` (dead letter id + token FRESCO por replay — la ligadura de generación: un claim viejo no puede acreditar una ejecución nueva); `CompleteNode` acredita DENTRO de la misma tx de completación — identidad exacta del dead letter (id+run+node) o nada, convergencia open→replayed, `recovery_impact_events` idempotente sobre el unique `dead_letter_id` (una carrera de doble terminal no puede duplicar), y el rollup O(1) (`ON CONFLICT (org_id) DO UPDATE total+=1, downtime+=, LEAST/GREATEST`) SOLO cuando el run es de producción.
- "La iniciación jamás es un win": solo el éxito TERMINAL del nodo reclamado acredita — el redrive contra un upstream aún roto termina en 0 impacto. El win de un sandbox registra su hecho inmutable pero nunca entra al rollup north-star.
- O(1) verificado por plan: EXPLAIN muestra Conflict Arbiter = PK sin scans. La rama exact-identity (runId+nodeId) no estampa claim — paridad con la referencia (sin dead letter no hay crédito).

## T-137 · Atribución atómica incidente/playbook (2026-07-31)
- El redrive ABRE el incidente de ownership en la misma tx (idempotente por el unique (org, dead_letter) del baseline; severidad default p3, SLA 24h, firma de error para clustering). El cierre viaja SOLO con el éxito terminal del nodo reclamado: CAS open→resolved con `sandbox_replay_succeeded`, `first_action_at` set-once desde `replay_claimed_at`, y el audit `recovery.item.resolved` en LA MISMA tx que el hecho de impacto — la aceptación del enqueue no puede disfrazarse de recovery ni hay ventana de crash entre el Value Dashboard y las vistas de ownership.
- Atribución de playbook: cuando el claim lleva playbook + validation run, el audit `recovery.playbook.applied` aterriza atómicamente (el receipt durable del playbook llega con su sustrato en T-139).
- Reconciliación T-055: `QueryVerifiedRecoveryStats` dejó el join ad-hoc DLQ↔eventos y ahora lee `recovery_impact_events` (hecho durable, generation-bound, replay_mode IS NULL) — la métrica es por construcción imposible de inflar por iniciación.
- `InsertAuditLogRow`: query sqlc para audits dentro de transacciones del engine (audit.Write es pool-level).

## T-138 · Circuit breaker (2026-07-31)
- Capa de decisión PURA (`internal/recovery/circuitbreaker.go`): kill switch env (default ON), resolución de umbral workflow-knob (false = opt-out explícito; 2..100) → org config → default 5, y el predicado (solo un workflow ACTIVE con racha ≥ umbral). La racha cuenta runs ordinarios consecutivos fallidos (sandbox excluido en la query; cualquier éxito la corta).
- Trip en `FailNode` FUERA de la tx durable (best-effort: el dead letter ya es durable, un fallo del breaker jamás rompe el camino DLQ): CAS `active→paused_circuit_breaker` + audit en UNA tx — bajo carrera de workers exactamente uno anuncia.
- La pausa cierra los puntos de entrada: `/start` → 409 nombrando la causa (`workflow_circuit_breaker_paused` vs `upstream_degraded`); el ingest ya bufereaba (T-040); el drop de cron llega con el scheduler (ola 6, seam listo).
- `POST /workflows/{id}/resume` deliberadamente MANUAL (nada sabe con autoridad que "el bug se fue"): CAS solo desde paused_circuit_breaker (otra fuente de pausa → 409 con status), audit del flip, y backfill oldest-first de los buffered con claims (`backfill_claim_token`, página 50, FOR UPDATE SKIP LOCKED) rematado por el CAS de trigger-start ampliado a `received|buffered` — cierra la divergencia pendiente de T-040. El input del run backfilled desenvuelve el anchor para calzar con el shape exacto del ingest.

## T-139 · Recovery Playbooks (2026-07-31)
- Ciclo de vida manual portado: draft idempotente por source-version (versión monotónica por (org, firma) con el retry acotado compartido), activación en tx que retira el active previo del match exacto y hace CAS draft→active — el índice parcial único del baseline (`one_active_match`) convierte una doble activación concurrente en 409 limpio; retire idempotente.
- La autoridad se re-gana en cada uso: `VerifyPlaybookReplayClaim` porta la cadena de evidencia completa de la referencia (playbook ACTIVE + workflow/firma exactos + run de validación succeeded en modo validation con parent correcto Y portando el playbook + workflow byte-idéntico al que correrá el replay). El sandbox de un playbook que FALLA lo auto-retira con `regressions++` en la MISMA tx del flip terminal (audit `recovery.playbook.regressed`).
- `RecordPlaybookApplied` (successful_uses++, set-once por validation run) viaja en la tx del impacto terminal — el recibo durable que T-137 dejó anotado. validate-fix pasó del 409 incondicional al matching real (firma del DLQ por `signature.NormalizeJSON` + snapshot fuente byte-igual).
- Rutas: POST /recovery/playbooks (draft desde evidencia fresca), GET match, POST {id}/activate|retire, gates viewer/editor según catálogo.

## T-140 · Drills medidos + dossier (2026-07-31)
- `internal/recovery/drilloutcome.go`: la composición pura de la referencia verbatim — un chain capado reporta `measurement_incomplete` en vez de inventar un desenlace; recovered domina accepted; el más reciente open es awaiting_action; claim sin resolución es replay_in_progress; la ventana de recurrencia post-recovery (7 días) fluye monitoring→clear/recurred; elapsed acotado desde la raíz.
- Los hechos salen del CTE del chain same-run/node (cap 100 + flag de capado, impacto terminal por dead letter, resoluciones explícitas por item/audit, sonda de recurrencia por firma compartida en producción) — como SQL crudo en la ruta porque el analizador de sqlc no tipa el chain materializado (precedente: el sustrato de memoria).
- Rutas viewer/recovery.read: `GET /recovery/drills/outcome?deadLetterId=` (proyección de UN drill desde su raíz) y `GET /recovery/drills/dossier` (las 50 raíces recientes con actividad de replay + summary por status — el payload JSON es el export del dossier).

## T-141 · Feedback + calibración de confianza (2026-07-31)
- `internal/recovery/calibration.go`: el fit puro de la referencia — buckets de 10 puntos, mínimos cuadrados ponderados, piso de 20 muestras, y el guard de monotonía (una pendiente no positiva REHÚSA la curva: aplicarla podría invertir el orden relativo de dos sugerencias; el read side conserva la confianza cruda). `ApplyCalibration` es monotónica por construcción y clamped [0,100].
- `POST /recovery/feedback` (editor/recovery.write): decisiones etiquetadas con el set cerrado de approaches, rawConfidence 0..100, comment acotado, audit `recovery.feedback`. `GET /recovery/calibrations` expone las curvas almacenadas.
- `RunCalibrationSweep`: por org con feedback en la ventana de 30 días Y el toggle `ai.confidenceCalibrationEnabled` (default on), ajusta una curva por approach (cap 5000 muestras) y upserta por (org, approach); abstinente cuando el fit rehúsa — nunca persiste una curva que pueda desorientar.
- Diferidos honestos: la APLICACIÓN de la curva en el diálogo del patch sigue en la lista de la ola 4 (decisión de usuario); el cableado del sweep a un cron llega con el scheduler (ola 6) — el método queda expuesto y probado.

## T-142 · Ownership + handoff (2026-07-31)
- `internal/domain/recoveryitem.go`: la escalera cerrada del incidente con la tabla ALLOWED_PRE_STATES de la referencia verbatim — la transición ES un CAS `status = ANY(pre_states)`, así el perdedor de un doble-click ve 409 en vez de doble-aplicar. Razones de resolución cerradas; `sandbox_replay_succeeded` solo la escribe el camino de impacto terminal (un operador no puede reclamarla a mano). Escalamiento sube severidad hacia p1.
- Rutas del drawer: GET /recovery/items (acotada 100) + POST /recovery/items/{id}/{action} con owner/severity en acknowledge, comentarios acotados (4000 chars, 200/item, append jsonb), `first_action_at` set-once y el audit del catálogo por acción.
- Handoff durable: upsert en `recovery_item_handoffs` por (org, item, destino) con `dispatch_count++` — y el outcome HONESTO `delivery_failed / dispatcher_unavailable` porque la entrega real (Slack/Linear/GitHub) llega con la ola de integraciones; el drawer ve la historia verdadera desde ya.

## T-143 · /dlq/queue read-model (2026-07-31)
- `internal/httpapi/recoveryqueue.go`: la cola de recuperación como read-model keyset — join de `dead_letters` con su overlay de `recovery_items` (proyección resumida: nunca los JSON ilimitados de replay), filtros server-side antes del tope para que un P1 viejo aflore igual, y cuatro sorts de orden total con NULLS LAST para las filas sin item.
- Cursor opaco por sort: base64url `{s,c,i,k}` sin firma (solo nombra una posición; el scope de org se re-aplica en cada query) y se decodifica contra el sort EFECTIVO — un cursor acuñado bajo otro sort se ignora y sirves página 1 en vez de desordenarla.
- El `/dlq` desnudo (sin `id`) deja de ser 400 y sirve el mismo join como array para el preview del Home — el gap que quedó anotado en T-064.
- SQL crudo con fragmentos de conjunto cerrado y TODO valor de usuario parametrizado; sqlc no puede tipar el predicado keyset por sort (mismo precedente que el CTE de drills).

## T-144 · Bulk recovery (cluster-members / cluster-apply / bulk-replay / resolve) (2026-07-31)
- `internal/httpapi/bulkrecovery.go`: las cuatro superficies multi-select sobre el sustrato de clusters. cluster-members enumera ids abiertos cuya firma normalizada coincide (mismo Context de normalización que /dlq/clusters, por eso los ids calzan con el rollup); cluster-apply re-valida CADA fila contra la firma reclamada en el server — una lista rancia entre fetch y apply se rechaza por fila, nunca se cuela.
- El fix aplicado: se valida UNA vez por la gramática y solo toca miembros del MISMO workflow cuyo nodo fallido sobrevive el patch. En el modelo revive-in-place del piloto, aplicar el fix = reemplazar `runs.input_json.workflow` DENTRO de la transacción del redrive (`RedriveDeadLetterWithOptions`) — el worker ejecuta cada nodo desde ese snapshot, así el nodo revivido corre el patch y el run registra la configuración que usó de verdad. El test lo prueba de punta a punta: dos runs rotos sanan a `succeeded` tras el apply.
- bulk-replay es el lote mixto sin firma (solo filas open; el claim CAS es de un solo uso — el segundo intento reporta el conflicto en el sobre parcial). resolve/bulk-resolve aceptan la pérdida y cierran el item vinculado como `accepted_loss` — un dismiss manual jamás se disfraza de victoria de replay.
- Divergencia documentada: el status del dead letter converge open→replayed en el impacto TERMINAL (postura T-136/T-137), no en el enqueue síncrono de la referencia; `downtimeEndedMs: 0` se mantiene por honestidad.

## T-145 · Recovery-home read-models (2026-07-31)
- `internal/httpapi/recoveryhome.go`: GET /recovery/home con secciones que se resuelven independientes — una proyección caída jamás borra los datos sanos del resto. scope=impact deja el poll de convergencia en un request (ledger O(1) del rollup, victorias del operador, overview de la cola); scope=full añade metrics/heatmap/casos/validación/clusters.
- La recurrencia REAL post-recovery: `QueryRecurredClusterSignatures` marca una firma solo si se recuperó con impacto TERMINAL dentro de la ventana y re-ocurrió dentro de sus 7 días de monitoring (replays excluidos por `replay_mode IS NULL` en ambos lados). La bandera viaja igual en el /dlq/clusters enfocado — mismo value compartido, así el Home y la vista enfocada no derivan.
- Dos cierres de consistencia que la recurrencia destapó: (1) el redrive no estampaba `recovery_requested_by` — las victorias por operador siempre daban 0; ahora `RedriveOptions.RequestedBy` viaja desde replay/bulk/cluster-apply; (2) la firma del recovery item era el MENSAJE crudo del error, no la firma normalizada de clusters — `DeadLetterSignature` unifica, sin eso el join de recurrencia por item nunca calzaba.

## T-146 · Alerting (2026-07-31)
- `internal/engine/alerts.go`: el despachador — políticas habilitadas por (org, trigger) del catálogo cerrado de 11 triggers, filtros por parámetros del payload (allowlist de workflows, patrón de firma, severities), cooldown dedupe por (policy, dedupeKey) y el registro durable en `alert_dispatches` con el resultado POR canal. La entrega webhook corre por el MISMO chokepoint HTTP del nodo `http` — validación SSRF, dial fijado y topes heredados gratis; slack/email/github registran `dispatcher_unavailable` honesto (misma postura que el handoff de T-142).
- Productores post-commit que jamás rompen su flujo primario: dlq.entry_created en afterTerminalFailure (dedupe por workflow+nodo — una tormenta del mismo nodo no spamea), recovery_item.created al abrir el incidente en el redrive, y workflow.circuit_breaker_tripped tras el trip (el CAS del breaker ya dedupea anunciantes concurrentes).
- Rutas: CRUD admin+alerts.write con 422 de lista estructurada / 409 por nombre único / update parcial, y el feed /alerts/recent acotado para el panel.

## T-147 · Run-explain + evidencia (2026-07-31)
- `internal/recovery/runexplain.go`: el builder puro del Run Explain Report — resumen, causa raíz por la MISMA taxonomía de firmas (suggestedOwner decide la próxima acción del operador), nodo fallido con resumen de error, timeline con tope 50 conservando la cola (el contexto del fallo vive al final), y el suggested fix leído del último audit de patch. Propiedad dura de seguridad: ninguna cadena libre sale sin re-pasar ScrubSecretShapes, encima de la redacción por claves en escritura.
- GET /reports/run-explain: descarga markdown/json con Content-Disposition, 404 uniforme para cross-org (sin distinción de enumeración), y audita cada export. POST /recovery/items/{id}/evidence: el artefacto de auditoría de UN incidente — incidente + dead letter con firma + run-explain completo del run original + el replay de validación más fresco + audit trail acotado; el patrón literal del mux le gana al wildcard {action}, así el gate queda editor+recovery.read como pide la referencia.

## T-148 · Primera acción set-once + recurrencia 7d (2026-07-31)
- `timeToFirstAction`: cuánto tarda un incidente en recibir su PRIMERA acción significativa — `first_action_at` lo estampa una sola vez la primera transición del operador (o el impacto terminal vía claim), y ninguna transición posterior lo mueve (probado contra psql). Los tenants sin items contribuyen por el claim de replay del dead letter, con doble exclusión para no muestrear dos veces el mismo incidente.
- `recurrence`: la ventana fija de 7 días anclada al evento de impacto INMUTABLE (el fix boundary es el éxito terminal). Resueltos vs reocurridos por firma normalizada + `stayedFixedRate` — la misma CTE que alimenta la bandera de clusters del Home, así el número del dashboard y la bandera visual jamás discrepan.

## T-149 · Rollouts: sustrato + asignación determinista (2026-07-31)
- `internal/engine/rollouts.go`: la escalera de creación corre entera dentro de una transacción con lock del workflow padre — bounds, canary estrictamente más nuevo Y último guardado, contratos de triggers externos byte-idénticos (stableJSON con claves ordenadas, mismo render que la referencia), un solo rollout activo (el índice único parcial convierte la carrera concurrente en active_exists), y el gate V2 que exige el receipt de calificación passed para el par exacto de versiones.
- El bucket es sha256 del par JSON [rolloutId, assignmentKey] → primer uint32 BE % 100 — determinista e idéntico al de la referencia, así una migración de motor no re-baraja asignaciones.
- `/v1/start` con id de workflow: la asignación REEMPLAZA el doc del request por el snapshot inmutable del variant y el run captura la elección congelada en sus columnas Y en el payload de run.started — los receipts de outcome (T-152) leerán la asignación congelada, jamás la fila mutable del rollout.

## T-150 · Triggers compatibles + version-write locking (2026-07-31)
- save + rollback rechazan 409 `workflow_rollout_active` mientras el rollout viva: acuñar una versión nueva bajo tráfico dividido desprendería al canary de "latest" en silencio (la asignación se apaga sola y nadie lo decidió). El operador termina el rollout, después escribe versiones.
- El DELETE tombstonea el workflow Y cancela el despliegue activo en la misma transacción — ningún rollout activo puede sobrevivir a su workflow borrado, y el create toma el mismo lock del padre, así tampoco puede aparecer uno en el medio.
- La compatibilidad estricta de triggers externos quedó probada con el par: canary que gana un `schedule` → 422; contratos byte-idénticos → create OK.

## T-151 · Receipts de calificación por par exacto (2026-07-31)
- `internal/recovery/qualification.go`: el candidato se juzga contra el dataset INMUTABLE del baseline más sus propias fixtures, por el MISMO evaluador semántico del runtime — determinista de punta a punta: ningún nodo ejecuta, ningún provider se llama, y ningún juez LLM otorga autoridad de mutación (la tesis de la ola, verbatim). V1→V2 corre en bootstrap (aún no hay dataset del baseline); con baseline V2, cada candidato debe conservar expectativas y cobertura de detectores o el receipt sale failed con `detector_uncovered`/`expected_mismatch`.
- El digest del dataset es sha256 del render estable (claves ordenadas) de {version, baseline, candidate} — el receipt queda anclado al contenido exacto que se evaluó, no a un id. El upsert usa el índice único de 6 columnas (org, workflow, par, dataset_version, digest).
- El gate del create de rollout exige status=passed para el PAR EXACTO: un receipt failed no desbloquea nada, y quedó probado por wire.

## T-152 · Auto-rollback + receipts terminales + repair (2026-07-31)
- `RecordWorkflowRolloutOutcome`: una sola transacción por outcome — receipt idempotente por PK run_id, re-validación completa (rollout ACTIVO, la variante debe calzar con la versión congelada del run, replays excluidos, cancelled no mueve tasas), contadores CAS, y el guardarraíl: cuando el canary alcanza la muestra mínima por debajo de la tasa mínima, el CAS a rolled_back y su audit con la evidencia observada comitean JUNTOS — exactamente una vez aunque dos workers compitan.
- Evidencia congelada: cuando el rollout termina (operador o guardarraíl), los terminales tardíos se ignoran — el dossier del rollout nunca cambia después de la decisión.
- Hooks post-commit en ambos caminos terminales + repair acotado para la ventana de crash (receipt y contador comitean juntos, así la ventana los pierde juntos y el repair los re-conduce juntos); corre como read-repair en el GET del rollout hasta que el cron llegue con la ola del scheduler.

## T-153 · Validación/replay jamás consumen canary (2026-07-31)
- El contrato queda garantizado por construcción: la asignación de rollout se resuelve en UN solo punto (el /start de producción). El hijo de validación nace con replay_mode=validation y campos de rollout NULL — no consume canary y nunca produce receipt de outcome. El redrive revive en sitio con la asignación congelada original; su terminal post-replay choca con el receipt existente (PK run_id) y los contadores no se mueven — un replay jamás infla la tasa del canary (el análogo del "replay initiation is never a recovered win").
- El nodo subworkflow sigue fuera del alcance ejecutable del piloto, así que el pin explícito de subworkflow no tiene superficie que guardar todavía — anotado para cuando el ejecutor entre.

## T-154 · Ingest con asignación de rollout (2026-07-31)
- La asignación se resuelve EN LA ACEPTACIÓN con el id durable del evento como assignment key, y se captura en el evento ANTES de que el run exista — el estado mutable del despliegue nunca redirige un evento después de aceptado, y una entrega duplicada adopta el evento persistido con su asignación original.
- El nodo trigger debe existir en el snapshot de la versión ASIGNADA: si el variant no lo tiene, 409 `trigger_no_matching_node` — por eso `webhook_received` queda deliberadamente FUERA del contrato de compatibilidad de triggers externos (schedule/email/file/mcp): el ingest re-resuelve y puede rechazar honesto, mientras los triggers de sistema no tienen a quién responderle un 409.
- El backfill del breaker honra la asignación CAPTURADA del evento buffered — ejecuta el snapshot del variant capturado, no la versión que el rollout señale al momento del resume.

## T-155 · Smokes web expertos (2026-07-31)
- Quinto smoke real contra Go: la ruta experta oculta (activeTab=recover) monta la cola de recuperación de verdad — el primer intento falló EXACTAMENTE como debía: el filtro Show=Open por defecto oculta la fila replayed, y el spec ahora prueba ese contrato (ampliar a All la revela).
- Búsqueda server-side que estrecha a una fila por runId, drawer abierto por el badge del incidente con acknowledge verificado por wire, y bulk replay por el multi-select real sanando dos runs contra el upstream curable del spec. 5/5 verdes.
- Gap conocido y honesto: el diálogo de cluster-apply (RecoveryDialog en modo cluster) no se conduce por UI en este smoke — la superficie está probada por wire (T-144) y el diálogo AI tiene su smoke de la ola 4; va al REPORT.

## T-156 · Matriz de fallos de recovery (2026-07-31)
- `internal/recovery/failmatrix`: el catálogo único de 28 casos hostiles en 5 superficies (replay, cluster-apply, validate-fix, items, queue) — cada caso fija status + código exactos o el sobre de éxito parcial. stdlib-only, sin ciclos, para que cualquier suite y el seeder lo importen.
- La regla del proyecto (feedback de olas previas) queda cumplida para recovery igual que para AI: un modo de fallo nuevo es UNA entrada en el catálogo y aterriza en todas las superficies consumidoras; nada de exemplares sueltos de una-sola-URL-mala.

## T-157 · Fixtures F18–F25 + goldens (2026-07-31)
- Ocho fixtures nuevas con verbos implementados en AMBOS drivers (gen-goldens.mjs para capturar del stack de referencia aislado; el harness Go para verificar): validación write-skip, breaker pausa/buffer/resume/backfill, observe/quarantine semánticos, rollout promovido/rolled-back sirviendo el snapshot correcto, y cluster-apply sanando el run con el fix.
- La captura destapó dos exigencias del schema Zod de referencia que el port Go toleraba: `contract.effects` es clave REQUERIDA (aunque vacía) y `failure.technical.stalledNode` es booleano requerido — las fixtures ahora los llevan y ambos backends los aceptan.
- Paridad Go 26/26 al PRIMER intento con la tabla de divergencias aceptadas VACÍA, y ×3 corridas idénticas. El golden de playbook queda diferido honesto (el loop está probado en Go por T-139; el golden cross-backend exigiría 6+ verbos más en ambos drivers).

## T-158 · REPORT-W5 (2026-07-31)
- Cierre de la ola 5: 30/30 tickets, 160/160 acumulados. El informe recoge los números (26 paquetes -race, paridad 26/26 ×3 con divergencias vacías, 5/5 smokes, matriz 28/28), las cuatro decisiones de diseño que valen conocer, y la lista completa de diferidos con su ola de destino.

## T-159 · Secret Store: envelope + root key externa (2026-07-31)
- `internal/secretstore`: envelope doble AES-256-GCM con AAD que ata ciphertext Y wrapped key a (org, credencial, versión) — el test lo prueba re-domiciliando la fila a otro org: el sello se rompe y la resolución falla cerrada. La propiedad que el comprador de compliance de verdad quiere está probada literal: el dump de la base no contiene el plaintext.
- Root key de UN secreto de proceso (inline o archivo), cacheada, jamás persistida, con probe de boot que falla rápido ante clave malformada — y unset sigue siendo legal (despliegues solo-legacy). El fail-closed de resolución lleva warn-once acotado por (fila, razón): el silencio total hacía indiagnosticable una root key partida entre API y worker.
- El firewall del ref forjado: un `janusly-secret://` dañado jamás cae al proveedor de entorno, aunque exista una env var con ese nombre exacto — probado plantando la env var.
- Detalle Go: `splitSeal` separa el `ciphertext||tag` combinado de Go en las dos columnas del schema (Node los guarda aparte) — el wire schema compartido manda.

## T-160 · Rutas de credenciales + rotación (2026-07-31)
- El loop CRUD entero con la propiedad de no-eco probada por grep del body: ni el valor, ni el ref managed, ni siquiera el NOMBRE de la env var legacy aparecen en respuesta alguna — la lista proyecta solo el bit `storage`.
- La rotación es el corazón: preview del blast radius (una pasada por la última versión de cada workflow buscando `config.credential`/`input.credential`), y el commit bajo row lock + CAS del token `ifMatch` — versión nueva insertada, referencia permutada y la versión ANTERIOR revocada en la misma transacción (verificado por psql que revoked_at quedó estampado). El equivalente Go del withAuditTx de referencia es la tx explícita + InsertAuditLogRow: mismo commit-or-rollback conjunto.
- El health usa el MISMO resolver org-aware que usará el runtime de integraciones (T-162) — managed y legacy no pueden derivar entre superficies; las conexiones MCP se evalúan con ese resolver también.

## T-161 · Readiness con credenciales + dos cierres colaterales (2026-07-31)
- El badge y el gate de producción ahora advierten `credential_missing` desde el MISMO resolver org-aware del runtime: una pasada del DAG (tope 50 combinado estricto), carga bulk, cada referencia única resuelta a lo sumo una vez. Fila inexistente, secreto irresoluble, alias MCP fantasma y env refs MCP incompletas (m-de-n) — cada una con su warn por nodo.
- Cierre colateral 1 — bug real destapado por el test: `mcp_tool` es ejecutable desde la ola 4 (el dispatch lo maneja y el test de motor lo corre), pero faltaba en `PilotNodeTypes` — el /start del API lo rechazaba como "no ejecutable". El test de motor usaba StartRun directo y nunca cruzó la validación del API. Una línea, y la paridad completa siguió verde.
- Cierre colateral 2 — LA CAUSA RAÍZ del flake intermitente de las olas 5-6: el breaker dispara POST-commit (afterTerminalFailure), así que un /start inmediato podía colarse antes del trip. Ambos drivers de paridad absorben ahora la carrera (retry con el run colado sumado a la racha y a seenRuns) y F20 asevera la pausa ANTES del ingest buffered. Paridad ×5 consecutivas verdes — el flake tiene explicación y fix, no superstición.

## T-162 · Chokepoint integration-tools + FetchHTTPTarget (2026-07-31)
- `executors.FetchHTTPTarget`: el primitivo en capas del reference — misma validación SSRF, dial fijado, re-validación por hop y stripping de credenciales por origen que el nodo http, pero SIN la política de fallo en no-2xx: los tools de integración son dueños de su sobre y necesitan el status y el body de las respuestas de error. Ningún SDK de vendor marca solo: toda salida de integración pasa por aquí.
- El chokepoint: gate de credencial (org-scoped por kind+nombre → SecretStore → rate limit por ORG+CREDENCIAL — una credencial ruidosa no mata las demás integraciones del tenant), recorder de usage que jamás rompe el tool, y sobres que NUNCA lanzan. `webhook.send` estrena el patrón: firma Stripe sobre los bytes exactos posteados (el receptor del test la VERIFICA), headers custom con defensas anti header-splitting.
- Bug propio atrapado a tiempo: puse el intercept de integración ANTES del gate de dry-run — una validación habría disparado el webhook de verdad. Reordenado: el sandbox gate corre primero, como manda el contrato.

## T-163 · email.send + postura segura (2026-07-31)
- La escalera de providers del reference, resuelta EN CADA llamada (hot-swap sin reinicio): resend y sendgrid reales por el seam Post guardado — cero SDKs de vendor, el chokepoint SSRF aplica solo; simulator solo con el gate local explícito; y noop como default seguro que responde el sobre {ok:false, "Mailer not configured"} — la postura segura ES que sin configuración deliberada no sale ningún correo, y el contrato write-side se sostiene sin throw.
- Postura del tenant desde org config (email.provider/email.from) con fallbacks de env; validaciones portadas 1:1 (subject ≤998 RFC 5322, text-o-html, topes de cuerpo, metadata ≤20 → tags/custom_args); el rate gate por org se convierte a sobre limpio.

## T-164 · pdf.generate + object store (2026-07-31)
- `internal/objectstore`: el seam de artefactos con la escalera del reference — local (file:// con guard DOBLE de traversal: clave saneada + verificación de prefijo absoluto), s3 como seam seleccionable con sobre honesto hasta que el driver SigV4 se enchufe (sin tocar callers), y noop default que jamás lanza.
- `pdf.generate` con escritor PDF 1.4 propio y CERO dependencias — la primera desviación deliberada de "port fiel": la referencia usa pdfkit; el pilot renderiza el mismo subconjunto markdown (headings, bold/italic por fuente, listas, code fences, reglas) con paginación real. Los `{{typos}}` quedan visibles en el PDF, como manda la referencia.
- El hallazgo de seguridad del ticket: el filename es input del AUTOR del workflow alimentando una clave de objeto — saneado a su último segmento sin dot-segments; el test prueba que un `../../evil/escape.pdf` queda confinado al prefijo del tenant y que /evil no existe en disco.

## T-165 · Acciones Slack firmadas (2026-07-31)
- El callback público con la escalera completa de defensas: HMAC v0 sobre el body crudo EXACTO (constant-time, fail-closed sin secret), team firmado, mapeo de usuarios acotado, y — la parte que importa — el member mapeado se autoriza por la capa NORMAL de roles/permisos en modo supabase: sin membresía real con editor+recovery.write, el clic de Slack no muta nada.
- El receipt de replay es el digest de (conexión, timestamp, body) y se reclama ATÓMICO con la mutación del item: la redelivery exacta responde duplicate sin segunda mutación, y un acknowledge fresco tras el primero pierde el CAS con 409 — dos idempotencias distintas, ambas probadas.
- Los rechazos se auditan con su razón (payload inválido, team ajeno, usuario sin mapear, sin permiso) — el operador ve los intentos, no solo los éxitos.

## T-167 — time.window + zonedwindow (2026-07-31)
El módulo neutral `internal/zonedwindow` porta zoned-window.ts: ParseLocalMinute (HH:MM 24h), ZonedClock (IANA vía time.LoadLocation + time/tzdata embebido para no depender de la imagen del contenedor) y Contains (fin exclusivo; ventana que cruza medianoche se corresponde con la membresía del día ANTERIOR). El tool `time.window` es el único primitivo zone-aware y conserva el sesgo del reference: configuración malformada (zona inválida, HH:MM malo, start==end, `at` no parseable) → error que reprueba el nodo, nunca un `false` silencioso. El sesgo opuesto (absorber como horario laboral) queda para el evaluador PagerDuty de T-166. Tests: cruce de medianoche viernes 22:00-06:00 (sábado 02:00 pertenece, domingo 02:00 no), Bogotá UTC-5, epoch-ms numérico.

## T-166 — PagerDuty V3 (2026-07-31)
La firma — no una sesión — es la autoridad del callback: se verifica el raw body contra TODOS los candidatos `v1=` del header (constant-time) con el secreto resuelto del Secret Store antes de tocar el pipeline. El pipeline durable de webhooks.go se extrajo a `ingestTriggerEventCore` parametrizado (matchNode + noMatch opaco + actor de auditoría), así el par webhook_received/pagerduty_incident comparte anchor, dedupe `(org, dedupe_key)`, storm guard, buffer-on-pause y el CAS de arranque — un solo camino, nunca dos. `policy.evaluate` parsea la forma PROYECTADA del incidente (assignedUserIds), que es lo que `incident.get` entrega río abajo; la primera corrida lo demostró (user_not_assigned con la forma cruda). El hallazgo grande: ni el runtime del reference ni el del piloto cascadean skips por aristas sin condición, así que el grafo generado por compilePagerDutyFlow del reference dispararía el snooze real en eventos DENTRO de horario laboral — bug flagueado para el repo Node; el grafo del test del piloto lleva la condición en toda la cadena de mutación. Integration test: escalera de defensa (403/403/404/400), off-hours → ack+snooze exactamente una vez, redelivery exacto converge sin segunda mutación, in-hours → rama ignorada con razón `event_in_working_hours`, ≥3 usage rows del chokepoint.

## T-168 — email ingest (2026-08-01)
La seam normalizada de email entra por el mismo pipeline durable que webhooks/PagerDuty; lo nuevo es el resolver org-wide (alias único entre los DAGs latest activos) y la disciplina de adjuntos: los cuerpos jamás tocan `trigger_events` (viajan base64 out-of-band, se descargan al object store con cap 1MiB por adjunto y nombre sanitizado — el objectstore rechaza claves con `..`, así que las secuencias se eliminan en vez de fallar la subida), y el pre-chequeo de dedupe por messageId corre ANTES de cualquier subida para que el retry de un relay no deje objetos huérfanos — el eventId determinista (sha256 org+dedupeKey) hace que fila y prefijo de claves coincidan en cualquier reintento. El core compartido ganó dos grados de libertad que el email necesitaba: dedupe NULL (messageId ausente → cada entrega es un evento nuevo; ON CONFLICT nunca dispara con NULL) y eventID inyectable. Test: gate DKIM, 404 opaco, 413, traversal en filename no escapa del prefijo org, oversize dropped, retry converge sin re-subir, allow-list de dominios, alias ambiguo 409.

## T-169 — file_dropped + mcp_server_event (2026-08-01)
Los dos triggers restantes del catálogo event-driven, cada uno con su postura de idempotencia del reference: file_dropped dedupea por (bucket, key, etag) — el retry del mismo evento converge y una re-subida (etag nuevo) legítimamente re-dispara — mientras mcp_server_event NO dedupea porque una notificación de recurso actualizado no trae identidad natural (dos notificaciones idénticas son dos hechos; el upstream es quien de-duplica). El selector de archivo filtra bucket exacto, prefijo y extensión (allow-list sin punto, case-insensitive); el de MCP filtra alias+URI exactos y opcionalmente los métodos de notificación. Ambos reutilizan resolveUniqueTriggerNode + ingestTriggerEventCore — cero código nuevo de pipeline. Test: los tres misses del selector de archivo (404 opaco), dedupe por etag en ambas direcciones, filtro de eventTypes, cap 413 del payload MCP, y dos notificaciones idénticas → dos runs distintos ambos verdes.

## T-170 — shadow ingestion de runtimes externos (2026-08-01)
El contrato es observación pura: la unión CloudEvents no tiene verbo de mutación, así que el estado sombra jamás puede confundirse con autoridad sobre el runtime origen, y los casos externos nunca suman al north-star de verified recovery. Las dos idempotencias viven separadas a propósito: el receipt por (connection, source, eventId) hace converger la redelivery exacta, y la monotonía por last_sequence hace que un evento tardío con secuencia menor quede RETENIDO como `stale` (evidencia forense) sin mover la proyección — el test lo prueba con un `succeeded` de secuencia 3 que no revive un run que la secuencia 5 marcó `failed`. Strict parsing a mano (Go no tiene z.strict(): allowlist de campos por tipo sobre el raw JSON), scrub recursivo + SafePersistPayload en todo lo proyectado, y el firewall de identidades: un id con forma de secreto se rechaza entero porque scrubearlo lo corrompería. Deshabilitar la conexión responde el mismo 404 opaco que una inexistente.

## T-171 — upstream health fail-open (2026-08-01)
La propiedad de seguridad que carga todo el peso es FAIL-OPEN: una página de estado caída no puede amplificar un outage pausando cada workflow suscrito — el poll inalcanzable/no-parseable registra lastErrorReason y deja el estado derivado (y las pausas) intacto. La pausa es idempotente por predicado (`WHERE status='active'`), así que un poll degradado repetido no re-audita; el resume sólo toca lo que ESTA fuente pausó (`WHERE status='paused_upstream_degraded'`). La suscripción viaja como lista de tags en el save body hacia la columna de workflow_versions y la decide la versión LATEST — quitar el tag en la versión nueva des-suscribe aunque versiones viejas lo tuvieran. El test recorre el ciclo completo con un probe conmutable: sano→nada, degradado→pausa+409 upstream_degraded en /start+buffer 202 en trigger, feed muerto→fail-open sin mover nada, recuperado→resume+/start verde.

## T-172 / T-173 — tools db.* (2026-08-01)
La frontera multi-tenant es la credencial org-scoped, no el SQL: Janusly valida la gramática cerrada (un statement, sin `;` ni comentarios, verbos DDL/sesión prohibidos, placeholders contiguos que igualan len(params)) y jamás reescribe la consulta del cliente — el aislamiento por filas vive en el DSN/rol/RLS de SU base. La validación corre ANTES del gate para que SQL malo no queme presupuesto de rate. Pools de una conexión por credencial con tope de 5 por org y swap por fingerprint del DSN (rotación de credencial = pool nuevo sin reinicio). El test de integración usa una tabla scratch alcanzada por su propio DSN como cualquier BD externa: describe con forma agrupada, read acotado con `truncated`, write que aterriza, transacción que revierte completa ante una violación NOT NULL a mitad de camino (el update previo vuelve a `paid`), y ningún envelope eco del `postgres://`.

## T-174 — loop for_each (2026-08-01)
Dos decisiones cargan el ticket. Primera: extraer la escalera de intercepción del tool node a `executeRegisteredTool` para que un tool se comporte idéntico lo invoque quien lo invoque — vector seams, skip write-side de dry-run, chokepoint de integración, registro plano; el loop no re-implementa nada. Segunda: el canal writeSide de punta a punta — el reference (runtime.ts:360) bloquea el retry de nodo completo cuando `error.writeSide === true`, y el piloto no tenía ese canal; ahora ExecErrorShape.WriteSide viaja por el puente richError hasta error_json y `RetryOrFail` lo consulta antes que la política. El test del dispatcher lo prueba de la única forma que importa: presupuesto excedido con tool write-side y retry declarado de 3 intentos → attempts==1. Render-antes-de-efectos también quedó pineado: con strict, el reporte de paths no resueltos dispara antes de que exista `loop.for_each.started`.

## T-175 / T-176 — subworkflow (2026-08-01)
El contrato que carga todo: la tx de arranque del hijo comete también el checkpoint exacto del padre — no existe ventana donde el hijo corra contra un padre que nunca pausó, porque los roots del hijo y la pausa del padre se vuelven visibles en el mismo commit. El handoff terminal es doblemente durable: el marcador se arma EN el mismo UPDATE del flip terminal (extensión de MarkRunTerminalFromRunning con el CASE de links ejecutables), el notifier inmediato del worker lo limpia solo tras asentar el checkpoint EXACTO (predicado por childRunId en el CAS — la semántica de "hermano exacto": un padre fallido asienta al hijo tardío sin reabrirse), y el reconciler con lease barre lo que un crash dejó armado — el test fuerza esa ventana a mano (nodo re-armado a waiting + marcador vencido) y verifica la reparación completa. El trampolín DeliverParentNotifications sube la cadena de padres en un loop acotado en vez de recursión. Bonus del ticket: el sqlc analyzer no traga CTEs recursivos — el walker de profundidad quedó en Go con lecturas puntuales acotadas, que a profundidad ≤5 es más barato que el CTE de todas formas.

## T-177 — nodo schedule (2026-08-01)
El sustrato de despacho es el due-clock de Postgres — el mismo patrón que las campañas de replay — porque el piloto no tiene BullMQ: cada entrada carga su `next_fire_at`, el sweep lo lease-a con SKIP LOCKED y el disparo avanza el reloj desde el cron REAL (no desde el lease). El parser cron es propio y de 5 campos con la semántica OR clásica entre día-de-mes y día-de-semana restringidos; sqlc no analiza contra la BD viva sino contra schema.sql, así que la migración exige `make migrate` + `make schema-dump` antes de `make generate` — quedó anotado. La fila `schedule` del pause table se cumple literal: el tick de un workflow pausado se descarta con auditoría y el reloj avanza — "la corrida de las 3am no significa nada a las 6am". El test recorre save→entrada, due→run con `triggeredBy: schedule`, pausa→drop auditado sin run, tombstone→cero entradas, restore→re-registro, y save sin el nodo→des-registro.

## T-178 / T-179 — crons de sistema + posture de vencidos (2026-08-01)
Los tres crons restantes tomaron la forma del piloto: sweeps con ticker sobre Postgres, no BullMQ. El auto-healing quedó supervisado de punta a punta con una decisión de costo explícita — la propuesta es determinista ($0, harden_retries) porque un LLM dentro de un cron es presupuesto que el piloto difiere; la escalera diagnose→proposed→validating→validated→applied/declined usa la validación sandbox real (snapshot parcheado, write sides skipped) y el apply reusa el redrive con fix-snapshot de la ola 5. El gate de riesgo exige ack también para evidencia `static` — la etiqueta de nacimiento del sandbox del piloto — no solo `writes_skipped`. La purga de consent no lleva bookkeeping de cancelación: la seguridad vive en el re-read del config al momento de disparar. T-179 terminó siendo una verificación de arquitectura: el due-clock durable de Postgres ES el reconciler de vencidos (el gap de polling se probó literalmente con un wakeup vencido huérfano que dispara exactamente una vez al reanudar), y el reaper cubre la otra mitad. Incidente del turno: Docker Desktop se cayó a mitad de los tests — `open -a Docker` + espera del daemon y la suite siguió.

## T-180 — snippets + packs + onboarding (2026-08-01)
Los tres pack.json del reference viajan embebidos VERBATIM (go:embed) con validación al boot — cero traducción, fidelidad total del catálogo. El hallazgo del ticket: workflows.id es PK GLOBAL, así que instalar el mismo pack en dos orgs colisionaba; el id de instalación quedó determinista por org (packId-hash8) y la re-instalación en el mismo org apila versiones sobre ese mismo id. El onboarding es derive-on-read puro — una sola query SQL con seis EXISTS calcula los hitos desde el estado durable que las demás features dejan (el pack instalado se lee del audit log, la recuperación del DLQ resuelto), y la fila persistida es solo high-water + latch; el test recorre el ciclo completo de verdad: instala pack → sandbox sample → inject-failure que aterriza un dead letter real → credencial + run verde → resolver el DLQ → onboarding completa con exactamente UN audit → restart re-abre desde la época.

## T-181 — health rollup + SLO + delta (2026-08-01)
El scorer es un port fórmula-por-fórmula con las constantes pineadas (el test de pesos-suman-1.0 incluido), pero el trabajo real fue la atribución de versión: los runs sin pin del piloto llevan `workflow_version_id = workflowId` (no un id de fila de versión), así que el join ingenuo del delta contaba cero runs. La versión efectiva de un run sin pin se deriva contando cuántas versiones existían al momento de crearse — determinista y sin migración. El SLO viaja en el save body hacia la columna slo_json que el baseline ya tenía; el evaluador respeta el piso de 5 muestras y el delta responde `hasEnoughData:false` honesto hasta que el lado post-Apply junta sus 5 runs, con el chequeo de same-failure normalizando los error_json de los dead letters post-corte contra la firma previa.

## T-182 — metadata + tags + folders (2026-08-01)
La superficie de organización con las tres posturas del reference intactas: la fila de metadata se upserta completa pero las rutas estrechas de folder/tags existen precisamente para que el Flows list (que solo conoce el folder) no borre el resto — el test mueve el folder y verifica que la descripción sobrevive. El audit de metadata proyecta la guía AI a `{configured, bytes}` (el test planta un valor marcado y verifica que no llega al audit_log). Los dropdowns distinct hacen join con workflows activos, así que el soft delete saca los tags del filtro al instante. Las operaciones bulk de tags manipulan el jsonb con `tags - from || to_jsonb(to)` para rename org-wide en un solo UPDATE.

## T-189 / T-190 — eval datasets + experiment harness (2026-08-01)
El sustrato de experiments quedó con sus dos invariantes de privacidad y autoridad intactos. Privacidad: la elegibilidad es `accepted AND eval_consent` sin excepciones, y el scrubbing corre dos veces (al construir el ejemplo y al servirlo/exportarlo) — el test planta un token con forma de secreto en el comentario del operador y verifica `[redacted]` en la lectura. Autoridad: la promoción es una RECOMENDACIÓN con razón en prosa; el runner no muta nada, el costo se reporta al lado pero nunca decide, y el umbral de 0.05 separa señal de ruido. El scorer json_schema reusa el validador del subset de inputs declarados de domain en vez de re-implementar la gramática; el juez LLM degrada a Jaccard determinista con el motivo registrado, así que una corrida sin API key completa a $0 con el mismo shape de summary — probado end-to-end por la ruta.

## T-191 / T-192 / T-193 / T-194 — SCIM directory sync (2026-08-01)
El módulo con más guardas por línea de la ola, y todas son del reference: el dispatcher corre replay → malformed_timestamp → dispatch, y el detalle que importa es cuál guarda LIBERA el claim de dedupe — solo el error real de I/O (para que el retry de WorkOS re-procese tras un blip de Postgres); un guard-skip lo retiene porque un replay legítimo debe seguir siendo replay. La asimetría de colisiones quedó literal y probada por ambos lados: el create absorbe filas SCIM-owned (re-attach, redelivery, group-before-create) pero deja intacta una fila human-invited — el test siembra un founder admin y verifica que ni el rol ni el invited_by se mueven — mientras el re-key bloquea CUALQUIER fila en el email destino porque ahí no hay lifecycle propio que absorber. La derivación v2 es pura (mayor rango gana, desconocido rank -1, sin mapeo → defaultRole byte-igual al flat) y el resync la reusa idéntica con invited_by omitido: re-sincronizar jamás inventa una autoridad que el próximo evento no habría producido. El fixture WorkOS es un firmante HMAC local de 5 líneas — jamás WorkOS real. Colateral que pagó el ticket: el pin de paridad del catálogo de audit (147) llevaba roto silenciosamente desde la ola 5 — nueve acciones raw-audit se habían inflado dentro de knownActions; quedaron en un mapa rawAuditActions separado junto a las 19 scim.*, el union volvió a 147 exacto y TestAuditCatalogPinned está verde de nuevo.

## T-183 — barrido F1 terminal (2026-08-01)
La lección del ticket es que "el web funciona" y "el web recibe lo que pide" son afirmaciones distintas: el smoke pasaba con paneles degradando en silencio detrás del ErrorBoundary. El sondeo se hizo contra el wire REAL del cliente (V1_READ_PATHS → /v1 con envelope, mutaciones y lecturas restantes legacy crudo, downloadFromApi siempre crudo) y eso reclasificó la mitad de los "gaps" aparentes: /runs y /status legacy nunca se llaman, /reports/run-explain viaja por descarga cruda, /recovery/playbooks solo se POSTea, y los 404 de rutas con path-param eran dominio correcto sobre entidades fantasma. Los siete cierres reales fueron todos baratos porque la feature ya existía — solo faltaba el wire exacto: el catálogo de templates se extrajo VERBATIM del reference con node --experimental-strip-types (el mismo patrón embed-no-traduzcas de los packs), y los aliases /v1 comparten el core legacy refactorizado (un handler, dos encoders — imposible que diverjan). El smoke de los 15 tabs exige ahora la card de packs renderizada, y esa exigencia pagó de inmediato: packView tiraba failureFixtures/nodeCount que los pack.json embebidos sí traían — paridad rota que ningún test de wire veía porque el panel "degradaba bien".

## T-184 — strangler + dual-run shadow (2026-08-01)
El comparador es la pieza que convierte "creemos que es igual" en un gate ejecutable: mismo corpus contra ambos backends vivos, diff normalizado, y CERO tolerancia fuera de una lista de divergencias anotadas con razón y destino. Lo revelador fue cuánto pagó en su primera corrida real: ocho bugs de paridad que ninguna suite previa veía porque cada una probaba SU lado contra SUS expectativas, no un lado contra el otro. Los dos gordos: el tool http.request sencillamente no existía en el catálogo del pilot (el nodo http sí; el tool que usan los planners y el AI Studio, no), y el hook que abre recovery items al caer un dead letter — la referencia lo hace en CADA insert con debounce de tormentas y severidad del metadata; el pilot solo lo hacía en redrive, y encima el view de /v1/dlq proyectaba recovery:null hardcodeado, así que ni el item de redrive se veía. También cayó una invención silenciosa: el vocabulario de severidad low..critical que el pilot le puso al metadata en T-182 — el picker del web manda p1..p4 y habría 400eado en producción. Las divergencias que QUEDAN están anotadas en el comparador y en CUTOVER-MAP.md con su destino (traceId OTel, granularidad de eventos, convención de version-id, y un artefacto del reference donde applyOrgConfigToEnv muta process.env y cuatro claves se auto-reportan source:env — ahí el honesto es Go). El mapa de cutover quedó en cinco fases por familia con el split Caddy de ejemplo; el rollback es re-apuntar el proxy porque el estado vive en el mismo Postgres.

## T-185 — HA final: kill-failover + soak 24h (2026-08-01)
El arnés de failover pagó dos veces antes de ponerse verde. Primera: el threshold de 5s del reaper se silenciaba contra el floor de 15 minutos — un guard correcto para producción que hacía imposible el harness; quedó overrideable SOLO por env explícito y con warning ruidoso, porque un operador HA con nodos cortos va a querer exactamente eso. Segunda y la valiosa: al correr la suite completa con el soak de 24h vivo, Postgres reventó en "too many clients" y el muestreo del pico (104 conexiones) llevó a un leak real que ninguna suite había visto — el stream hub secuestra (Hijack) su conexión LISTEN fuera del pool con contexto Background, así que pool.Close no puede tocarla y cada harness de test filtraba una conexión para siempre; docenas de tests después, el presupuesto del servidor se acababa. En producción multi-réplica con reinicios frecuentes ese mismo leak habría crecido en silencio. El fix es un constructor con shutdown que cancela el hub, y la prueba de que era ESO: la suite completa ahora corre verde CON el soak vivo al lado. El failover en sí confirmó la tesis del claim ladder: 61/61 runs terminales tras un SIGKILL sin drain, el único "failed" es el claim del replica muerto cayendo ruidoso al DLQ (recuperado, nunca duplicado — attempts=1 en todos los nodos), y el replica reincorporado sirve de una. El soak de 24h queda corriendo en base aislada con pools acotados; su veredicto se escribe solo en SOAK.md.

## T-186 — revisión de seguridad (2026-08-01)
La regla del ticket fue "nada sin test": el dossier lista superficies con el nombre del test que las cubre, y lo que no tenía test se escribió. El scrub e2e enseñó la lección más fina de la ola: al plantar un secreto en la config de un nodo, el detalle del run LO DEVOLVIÓ — y perseguirlo reveló que runs.input_json está fuera del chokepoint de persistencia segura en los DOS engines (el reference tampoco lo redacta; verificado en start-run.ts). No es un descuido del port sino una postura heredada: el doc del run es el material de replay y la defensa sancionada es {{secret.X}} más el gate de producción — que el mismo test ahora asevera (422 en /start con modo producción). La decisión honesta fue no "arreglar" unilateralmente en Go lo que divergiría del reference, documentar el residual, y levantar el flag al repo Node con el precedente que sugiere el fix (dead_letters.workflow_json sí se key-redacta y también sirve replays). El sweep de editor cerró el hueco de la matriz de rangos: viewer y editor ahora barren el registry completo con las tres respuestas posibles pineadas por patrón.

## T-187 — SDK Python vivo + runbook + REPORT-W6 (2026-08-01)
El dato del cierre: el SDK Python pasó 5/5 contra el binario Go AL PRIMER INTENTO de wire — el flujo de dos pasos de start, el unwrap del envelope v1, el mapeo del 403 uniforme y el conflicto de cancel funcionaron sin tocar nada del SDK ni de Go; el único arreglo fue del test mismo (runs.list es un iterator paginante, no una lista). Esa es la validación más externa posible de que el wire ES el mismo: un cliente escrito contra Node, con sus propios contratos tipados y su fail-closed de protocolo, no distingue el backend. La lane quedó ejecutable (run-sdk-live.mjs) con el detalle de auth que importa: service token real y membresía sembrada porque service-token jamás auto-otorga. El runbook escribe lo que el mapa no decía: el switch es solo tráfico porque el estado vive en el mismo Postgres, el rollback es re-apuntar el proxy, y el caso divergente entra al corpus del comparador ANTES de reintentar — el dual-run como gate permanente, no como evento de la ola. El REPORT llena la plantilla go/no-go con la evidencia de cada criterio y recomienda GO por fase 1; el soak de 24h sigue corriendo solo y su veredicto se anexa cuando aterrice.

## T-500 — version-id real y semántica de conteo (2026-08-01)
El ticket enseñó a no confiar en el propio diagnóstico de hace un día: el spec asumía que faltaba estampar versiones reales, pero el censo de call sites mostró que TODOS los caminos engine-driven ya lo hacían desde sus olas — y que Node tampoco resuelve versión en el camino doc-posted (verificado en reads.ts, no supuesto). La divergencia real vivía en una sola cosa: el pilot contaba runs con un OR generoso (fila de versión O doc-id) donde Node cuenta solo runs version-linked. Dos queries alineadas, dos divergencias esperadas borradas del comparador, y workflow-trash pasó a OK limpio — el dual-run como juez, otra vez. La decisión de NO tocar la atribución de salud también importa: su coalesce ya prefería la fila real y degradaba a la derivación por conteo para filas históricas — exactamente el comportamiento de compatibilidad que el spec pedía, ya construido en T-181. Un test de contrato viejo pineaba la semántica generosa; se actualizó con la nota de por qué (la clase de cambio que sin el §9 se vería como regresión).

## T-505 — paridad del event-stream (2026-08-01)
Dos lecciones, una de fidelidad y una de medición. La de fidelidad: el spec decía node.started y el noveno evento era un misterio — el dump guardado del comparador tenía la verdad exacta (node.running, y run.status_checked como marcador del settle del fan-in). Portar del DUMP y no de la memoria evitó inventar un vocabulario que no existe. La de medición casi me hace revertir un cambio correcto: el primer bench gritó −93% de regresión... incluyendo list, que no toqué — la pista de que el instrumento estaba roto, no el código. El bisect por stash daba señales confusas porque cada corrida flotaba en la varianza del soak co-residente (mismo Postgres, mismo fsync). El movimiento que resolvió: SIGSTOP a todo el árbol del soak (preserva sus 24 horas), A/B adyacente en frío — y con los cambios el motor salió MÁS rápido que sin ellos (51.9 vs 44.8 runs/s). La regla queda escrita: ningún veredicto de bench vale mientras el soak comparte la máquina; congelar, medir, descongelar. Los streams quedaron byte-idénticos contra Node y al comparador solo le queda traceId, que es exactamente T-504.

## T-511 — goleak + gate de conexiones (2026-08-01)
El gate pagó antes de terminar de instalarse: la primera corrida de engine bajo goleak encontró que los fixtures servidor MCP dejan vivos los readers jsonrpc2 por-sesión después de que el CLIENTE cierra — el session.Close del lado cliente no derriba el lado servidor del streamable-HTTP, y cada test dejaba dos goroutines para siempre. La fuga era de los tests (fixtures), no de producción, pero es exactamente la clase de descubrimiento que justifica el gate: nadie la habría buscado. La decisión de diseño que quedó: keep-alives del transporte HTTP se CIERRAN en el TestMain en vez de ignorarse (un allowlist es deuda que crece; un CloseIdleConnections es cero deuda), y el allowlist real tiene UNA entrada con su razón escrita. El gate de conexiones convierte la lección del LISTEN hijackeado de T-185 en mecánica: diez ciclos de harness, baseline +2 o fallo — si alguien vuelve a secuestrar una conexión fuera del pool, CI lo dice antes que el soak.

## T-512 — runner supervisado de sweeps (2026-08-01)
Antes del ticket, un pánico en cualquiera de los nueve loops de fondo mataba el proceso completo — el reaper, la purga de memoria y el pump de campañas compartían destino con el bug más tonto de cualquiera de ellos. El runner les da tres garantías: el pánico se recupera con su stack en el log y el sweep reinicia con backoff (nunca más rápido que la causa del pánico permite), el retorno limpio se respeta como final (un loop que terminó su trabajo no es un loop roto), y el shutdown drena TODO antes de devolver el control — que es exactamente la disciplina que goleak impone en los tests, ahora aplicada al binario real. El failover re-corrido bajo el runner confirma que la supervisión no cambió la semántica de crash-recovery: 61/61 terminales con el mismo exactly-once.

## T-506 — el despertador que ya existía (2026-08-01)
El backlog de mejora se escribió mirando el poll de 50ms de los tests y asumió que el despacho era poll-driven — el censo real mostró que RunWorkers lleva desde su ola con el listener LISTEN/NOTIFY correcto (hijack con cierre por contexto, señal coalescida, poll como fallback), exactamente el diseño que el ticket pedía construir. La deuda real era de EVIDENCIA, no de código: nada probaba que el wake efectivamente corta el poll. El test nuevo lo prueba con el truco de invertir el poll — subirlo a 2 segundos y exigir que una cadena de 3 saltos termine en fracción de UN tick: mediana 163ms, tres despertares por NOTIFY encadenados. Segunda vez en la ola que el spec de un ticket resulta más viejo que el código (T-500 igual); la lección operativa es censar antes de construir.

## T-503 — queries por contexto (2026-08-01)
El split mecánico trajo su propia trampa de verificación: el primer diff "byte-idéntico" comparaba contra un archivo generado que sqlc ya ni siquiera tocaba — evidencia vacía que parecía perfecta. La equivalencia honesta terminó siendo el conjunto de símbolos generados (795 declaraciones idénticas), el build y la suite — y el guard de drift del ci resultó agnóstico al layout porque siempre fue un git diff del directorio, no del archivo. Once archivos de contexto, ninguno sobre 500 líneas, y el T-507 (barrido EXPLAIN) ya tiene dónde anotar por contexto.

## T-501 — v1.go en cuatro (2026-08-01)
Split por rangos de declaración con goimports podando por archivo — el corte mecánico ideal: el guard es que la suite de contrato no notó NADA, porque no había nada que notar. La estructura resultante lee como el índice que el archivo monolítico escondía: constructor y auth en v1.go, sobres y helpers en encoding, y los dos planos de rutas (runs y workflows) cada uno con su vida.

## T-502 — scim en cinco (2026-08-01)
El spec decía tres archivos; el módulo pidió cinco — el receptor público del webhook y los write paths de membresía son fronteras reales (autorización distinta, transaccionalidad distinta) que merecían archivo propio en vez de estirarse dentro de dispatch y routes. La suite del ciclo de vida no movió una expectativa.

## T-507 — el barrido EXPLAIN (2026-08-01)
La decisión que hace el gate sostenible: preparar las queries desde las CONSTANTES generadas por sqlc en vez de copiarlas — el test vive en package store y referencia los strings directamente, así que si una query cambia, el barrido barre la nueva sin que nadie lo recuerde. La aserción es deliberadamente conservadora: con enable_seqscan=off, un Seq Scan sobreviviente prueba que ningún índice PUEDE servir el predicado — independiente del tamaño de datos, sin seeds ni ANALYZE. De doce queries, once pasaron y la que falló era real: runs sin índice por workflow_version_id, exactamente el camino que T-500 acababa de convertir en el join canónico de conteos. El patrón two-file del reference necesitó adaptación a goose (que rechaza dos archivos de la misma versión — el runbook CONCURRENTLY vive ahora en rollouts/ con su README). Queda escrito el límite: este gate caza índices AUSENTES; el óptimo bajo datos reales es asunto del bench hostil de T-535.

## T-525 — el gate obligatorio sin el churn (2026-08-01)
El spec pedía migrar 143 mounts a un helper para que montar sin gate no compilara — pero el censo mostró que el registry ya era la fuente única y que la migración masiva solo movía texto. El agujero real era otro: un mount cuyo patrón no estuviera en el registry pasaba en silencio como auth-only. La inversión lo cierra mejor que el plan original: el middleware falla CERRADO ante patrón no registrado (con las 6 rutas auth-only del contrato en allowlist explícita y documentada), así que el olvido se manifiesta como 500 ruidoso en el primer test que toque la ruta — no hace falta recordar nada. El helper route() queda para el código nuevo, que es donde el patrón colocado paga. La meta de "-400 líneas" se descartó a conciencia: era el medio, no el fin, y el fin quedó mejor servido.

## T-526 — complete.go en cuatro, con susto (2026-08-01)
El split mecánico casi se come un archivo vivo: el spec nombraba "readiness.go" y el paquete YA tenía un readiness.go de 43 líneas con los predicados puros del DAG — mi Write lo pisó y el build lo delató en segundos (dos símbolos huérfanos). Recuperado de HEAD sin pérdida y el archivo nuevo bautizado downstream.go, que además es el nombre más honesto para lo que contiene (programar lo siguiente + asentar el run). La regla que queda: listar el paquete antes de crear archivos en un refactor — los nombres de un spec escrito ayer no saben qué existe hoy.
