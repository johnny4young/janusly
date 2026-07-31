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
