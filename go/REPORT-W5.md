# Informe de ola 5 — pilot Go

**Corte:** 2026-07-31 · rama `go-pilot` (174 commits sobre `develop@dfde6a31`)
· 30/30 tickets de la ola `done` (T-129..T-158); 160/160 acumulados en el
plan (olas 1–5 completas). Suite: 26 paquetes verdes con `-race` + goose;
lint 0; paridad semántica 26/26 fixtures ×3 corridas con divergencias
aceptadas VACÍAS; smoke web 5/5; matriz de fallos de recovery 28/28.

## Qué es el pilot ahora

Tras la ola 4 el pilot tenía el pipeline AI completo; tras la ola 5 tiene
**el sistema de recuperación avanzado y los despliegues canary enteros**,
bajo la tesis de la ola aplicada verbatim: *ningún juez LLM otorga
autoridad de mutación*. Todo lo que decide — detectores semánticos,
calificación de candidatos, receipts de outcome, auto-rollback — es
determinista, durable y auditado; el LLM solo sugiere.

### Lo nuevo por área

| Área | Estado |
|---|---|
| Casos de recuperación durables: escalera de 12 estados verbatim, transición = CAS + receipt append-only en la MISMA transacción (transición sin receipt imposible), ids semánticos estables | ✅ T-129 |
| Contratos V1/V2 (`domain.Parse` valida `recovery.contract`): V1 semántica deshabilitada por regla dura; V2 determinista con detectores expression/schema + fixtures acotadas; evaluador semántico de runtime en `internal/recovery` | ✅ T-130 |
| Perfiles de autonomía Nivel 0–4: override por fallo ≤ techo del workflow, fail-closed sin contrato, agregado con miembro no-disponible envenenando | ✅ T-131 |
| Reglas fail-closed de guardado (efecto no declarado, fuente diferida, dominancia detector→efecto, fixtures replay-verificadas) + intercepción de runtime: observe registra el caso, quarantine parquea el run ANTES de agendar downstream; sandbox nunca crea casos durables | ✅ T-132 |
| Runs de validación: `DryRun` calculado UNA vez desde `replay_mode`, tools write-side y métodos HTTP sensibles saltados, `validation_evidence_level='static'` de nacimiento | ✅ T-133 |
| `/dlq/validate-fix` con forma de CONTINUACIÓN (ancestros copian contexto terminal, nodo fallido re-armado, resto skipped) + **F05 CERRADO**: el redrive re-arma attempt a 1 — paridad sin excepciones | ✅ T-134/T-135 |
| Impacto terminal generation-bound: claim token fresco por replay → convergencia CAS → `recovery_impact_events` idempotente (PK dead_letter) + rollup O(1); la iniciación jamás acredita | ✅ T-136 |
| Atribución atómica de incidentes/playbooks en la cola del impacto; `verifiedRecovery` (p50/p90) leyendo los hechos durables | ✅ T-137 |
| Circuit breaker: decisión pura + pausa CAS en racha, resume manual con backfill oldest-first de eventos buffered (CAS extendido a received/buffered — divergencia T-040 cerrada) | ✅ T-138 |
| Playbooks evidence-gated: draft/activate/retire con único-activo parcial, claims de replay VERIFICADOS (run de validación fresco + workflow byte-igual), regresión auto-retira | ✅ T-139 |
| Drill outcomes medidos (precedencia capped→recovered→accepted→awaiting) + dossier por org (el JSON es el export) | ✅ T-140 |
| Calibración de confianza: fit por mínimos cuadrados en buckets, curvas solo monotónicas, abstinencia bajo el piso; feedback con labels cerrados | ✅ T-141 |
| Ownership del incidente: escalera CAS verbatim (doble-click pierde 409), `sandbox_replay_succeeded` vetada a mano, handoff durable honesto (`delivery_failed`/`dispatcher_unavailable` hasta integraciones) | ✅ T-142 |
| `/dlq/queue` keyset por sort (4 órdenes totales, cursor decodificado contra el sort EFECTIVO, filtros server-side antes del tope) — gap T-064 cerrado; `/dlq` desnudo vuelve a ser array | ✅ T-143 |
| Bulk recovery: cluster-members por firma, cluster-apply re-validando CADA fila + fix aplicado por **snapshot swap en la transacción del redrive** (el run revivido ejecuta el patch y lo registra), bulk-replay de lote mixto, resolve/bulk-resolve con cierre `accepted_loss` honesto | ✅ T-144 |
| Home coalescido con secciones independientes + clusters con recurrencia post-recovery REAL (7 días anclados al impacto inmutable); cierres: `recovery_requested_by` estampado (victorias por operador dejan de ser 0) y firma de item = normalizador de clusters | ✅ T-145 |
| Alerting: 11 triggers cerrados, cooldown dedupe, entrega webhook por el MISMO chokepoint HTTP del nodo (SSRF heredado), 3 productores post-commit reales, CRUD + feed | ✅ T-146 |
| Run-explain (builder puro, causa raíz por taxonomía compartida, timeline tope 50 cola, todo re-scrubbed) + evidencia de incidente (5 bloques + audit trail acotado) | ✅ T-147 |
| `timeToFirstAction` set-once (probado contra psql que la segunda transición NO mueve la estampa) + recurrencia 7d atada al impacto | ✅ T-148 |
| **Rollouts completos**: sustrato con escalera de validación bajo lock del padre + bucket sha256 determinista + asignación CONGELADA en runs/eventos (T-149); version-write locking + delete cancela atómico (T-150); receipts de calificación deterministas por par exacto con gate passed (T-151); receipts de outcome idempotentes + auto-rollback por muestra mínima con audit atómico + repair de ventana de crash (T-152); validación/replay jamás consumen canary (T-153); ingest con asignación en la ACEPTACIÓN + nodo exacto en la versión asignada → 409 (T-154) | ✅ T-149..T-154 |
| Quinto smoke web experto: cola real (filtro Show, búsqueda server-side), drawer con acknowledge por wire, bulk replay multi-select — 5/5 verdes | ✅ T-155 |
| Matriz de fallos de recovery: catálogo único de 28 casos en 5 superficies, cada uno fijando status + código exactos | ✅ T-156 |
| Fixtures F18–F25 + goldens capturados SOLO vía stack de referencia aislado; paridad 26/26 al primer intento ×3, divergencias aceptadas VACÍAS | ✅ T-157 |

## Números

- **Suites:** 26 paquetes Go verdes con `-race` (unit + integration sobre
  Postgres real con goose); `make lint` 0 issues.
- **Paridad:** 26/26 fixtures (F01–F25) contra goldens del stack de
  referencia; tabla de divergencias aceptadas vacía (F05 cerrado en esta
  ola); ×3 corridas byte-idénticas.
- **Smokes web:** 5/5 (boot, operador, AI studio $0, human form, cola
  experta de recovery).
- **Matriz de fallos:** 28/28 casos hostiles (replay 6, cluster 7,
  validate 5, items 7, queue 3).
- **Queries sqlc nuevas:** ~60 en la ola; el CTE de drills y el keyset por
  sort viven como SQL crudo documentado (sqlc no los tipa — precedente del
  sustrato de memoria).

## Decisiones de diseño que valen conocer

1. **Snapshot swap como "replay con fix"**: el modelo revive-in-place del
   pilot aplica un fix reemplazando `runs.input_json.workflow` DENTRO de la
   transacción del redrive — el worker ejecuta cada nodo desde ese
   snapshot, así el run registra la configuración que de verdad corrió.
2. **La asignación de rollout se congela al capturar** (start o aceptación
   del trigger) — receipts, backfill y auditoría leen la elección
   congelada, nunca la fila mutable del rollout. La evidencia de un rollout
   terminado es INMUTABLE (terminales tardíos ignorados).
3. **Consistencia de firmas**: el redrive estampa la firma NORMALIZADA de
   clusters en el item (antes era el mensaje crudo) — recurrencia por item,
   bandera de clusters y métricas leen el mismo vocabulario.
4. **Honestidad sobre entrega**: handoffs y canales slack/email/github
   registran `dispatcher_unavailable` durable en vez de fingir éxito; el
   webhook entrega DE VERDAD por el chokepoint SSRF del nodo http.

## Diferido (decisión del usuario / olas siguientes)

Arrastrado de la ola 4:
- Push batched + verificación CI (a pedido del usuario — repo privado).
- Corrida golden de evals con API key real.
- Receta PagerDuty determinista (superficie de integraciones).
- APLICACIÓN de la curva de calibración en el diálogo de patch (UI).
- Validación de `outputSchema` en el catálogo de tools.

Nuevo de la ola 5 (con destino):
- **Entrega real de handoffs + canales de alerta slack/email/github** → ola
  de integraciones (los registros durables ya guardan la historia honesta).
- **Cron wiring**: sweep de calibración, drop de ticks de cron del breaker,
  reconciler de outcomes de rollout → ola del scheduler (hoy: read-repair
  en el GET + invocación directa probada).
- **Delivery de reportes (run-explain/evidencia) a Slack/GitHub/webhook** →
  ola de integraciones.
- **Diálogo web de cluster-apply por UI** en el smoke (la superficie está
  probada por wire; el diálogo AI tiene su smoke de la ola 4).
- **Golden cross-backend del loop de playbooks** (probado en Go por T-139;
  exigiría 6+ verbos más en ambos drivers).
- **Pins de subworkflow vs canary**: sin superficie aún (el ejecutor de
  subworkflow no está en el alcance del pilot).
- Flake aislado observado UNA vez en la suite httpapi completa (no
  reproducido en 3 corridas seguidas) — anotado para la matriz de flakes.
