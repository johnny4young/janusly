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
