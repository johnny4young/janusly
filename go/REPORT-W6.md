# REPORT-W6 — Ola 6: integraciones, scheduler, subworkflows, listo-para-cutover

> Historical implementation snapshot (2026-08-01). Wave 7 later implemented
> the deferred route families and closed several listed divergences. See
> `REPORT-W7.md` for the implementation closure and `AUDIT.md` for independent
> certification status. This report is not a current production approval.

Cierre: 2026-08-01 · 35/35 tickets (T-159..T-187, T-189..T-194; T-188 en ola 3)
· 190/190 acumulados del plan · dirección estratégica vigente (2026-07-31):
**el pilot es la base definitiva; todo migra, nada queda "en Node" permanente.**

## Qué es la plataforma al cierre de la ola

Backend Go completo para el web real: núcleo de ejecución (con
subworkflows atómicos, schedule con due-clock propio, for_each acotado),
integraciones firmadas de punta a punta (PagerDuty V3, Slack, external
runtimes CloudEvents, email/file/MCP triggers, upstream health fail-open,
db.* con gramática cerrada), SCIM WorkOS completo (guardas + colisiones +
derivación de roles + resync), superficie de producto (templates,
snippets, packs, onboarding, health+SLO, metadata/tags/folders), evals +
experiment harness recommendation-only, y el andamiaje de cutover:
comparador dual-run, mapa strangler, runbook por tenant, revisión de
seguridad y lanes HA/failover/soak/SDK.

## La evidencia que más pesa

| Área | Evidencia | Resultado |
| --- | --- | --- |
| Paridad de wire | `make dual` — corpus idéntico contra el reference pinneado y Go, diff normalizado | **27/27** (divergencias esperadas anotadas con destino); cazó 8 bugs de paridad reales antes de ponerse verde |
| Paridad semántica | `make parity` (goldens F01..) | verde |
| Web real | smoke Playwright: 5 flujos + **15 tabs sin pageerrors** | 6/6 (y cazó el panel de packs cayendo al boundary) |
| HA / crash | `make failover` ×3 (SIGKILL sin drain) + `make test-ha` ×3 | 61/61 runs terminales, exactly-once nodo a nodo, rejoin sirve |
| Estabilidad | soak 24h EN CURSO en base aislada (k6 sostenido; veredicto automático >10% de crecimiento) | arnés verde; veredicto final aterriza en `conformance/perf/SOAK.md` (precedente ola 3: 1h estable ~33MB RSS) |
| Seguridad | `SECURITY-REVIEW.md` — matrices SSRF (nodo/tool/MCP), scrub e2e por el wire, sweeps authz viewer+editor del registry completo, 5 verificadores de firma fail-closed | verde; 2 hallazgos corregidos + 1 residual documentado y flaggeado al reference |
| SDKs | `node conformance/run-sdk-live.mjs` — pytest del SDK Python contra el binario Go (service token real) | **5/5** al primer wire (start dos-pasos, poll, 403 uniforme, métricas, cancel-conflict) |
| Suite | `-race -tags integration` sobre TODOS los paquetes + `make lint` | verde / 0 issues — CON el soak vivo al lado |

## Hallazgos que valen conocer (la ola en cuatro lecciones)

1. **El comparador dual-run es la herramienta que faltaba**: ocho bugs de
   paridad que ninguna suite unilateral veía (tool `http.request`
   ausente, hook de recovery items del DLQ + overlay hardcodeado a null,
   vocabulario de severidad inventado, wire shapes de members/org-config/
   validación). "Cada lado prueba SUS expectativas" no detecta drift.
2. **El leak que solo aparece bajo presión real**: el stream hub
   secuestraba su conexión LISTEN fuera del pool (invisible a
   `pool.Close`); solo el pico de 104 conexiones con el soak vivo lo
   destapó. Fix con shutdown explícito; habría mordido producción
   multi-réplica.
3. **Los guards buenos también estorban**: el floor de 15m del reaper
   absorbía el threshold del arnés de failover en silencio — quedó
   overrideable solo por env explícito con warning ruidoso.
4. **`runs.input_json` está fuera del chokepoint de scrub EN AMBOS
   engines** — postura heredada ({{secret.X}} + gate de producción),
   residual documentado y flag levantado al repo Node.

## Divergencias con destino (resumen; detalle en CUTOVER-MAP.md)

traceId OTel · granularidad del event-stream · convención de version-id
en runCount · artefacto env-overlay del reference en org-config ·
taxonomía de nombres de error por runtime. Ninguna bloquea las fases 1-3.

## Diferido (con destino)

- Fases 4-5 del mapa: `/ai/explain-*` + review/suggest, billing por
  workflow, causal, replay-lab, identidad multi-org/invitación por
  página → post-pilot, familia por familia sobre el comparador.
- Alinear emisión de eventos (node.queued/started) antes del cutover
  fino del timeline de Activity.
- Resolver version-id real en `/start` de guardados (pre-requisito de la
  familia Flows para runCount idéntico).
- Push por lotes + CI real (regla del repo privado, a pedido del usuario).
- Veredicto del soak 24h (autónomo; se anexa al llegar).

## Plantilla go/no-go (decisión del timebox)

| Criterio | Umbral | Estado |
| --- | --- | --- |
| Paridad de wire sobre corpus real | 0 diffs fuera de lista anotada | ✅ 27/27 |
| Web real completo sin errores | 15/15 tabs + 5 flujos | ✅ |
| Exactly-once bajo crash de réplica | 0 dobles ejecuciones ×3 corridas | ✅ |
| Estabilidad sostenida | soak sin crecimiento >10% | ✅ 24h COMPLETO (2026-08-02): heap plano ~8.8 MB las últimas 18h, RSS a la baja (final 28 MB), goroutines planas ~41; el flag automático del veredicto fue artefacto del baseline (outage del Postgres del host + ventanas SIGSTOP de benches deprimieron el primer cuarto) — investigación en SOAK.md anexo T-510 |
| Seguridad ejecutable | matrices SSRF/scrub/authz verdes | ✅ |
| SDK externo contra Go | pytest live verde | ✅ 5/5 |
| Rollback operativo | runbook + mismo-Postgres | ✅ documentado |

**Recomendación: GO.** Arrancar fase 1 del strangler (núcleo de
ejecución) por un tenant interno con el runbook, con `make dual` como
gate de regresión permanente y las fases 4-5 portándose detrás del
proxy. El último criterio pendiente cerró el 2026-08-02: el soak de 24h
terminó ESTABLE (1412 muestras; heap plano, RSS decreciente, goroutines
planas — anexo T-510 en SOAK.md con la investigación del falso flag).
Todos los criterios del go/no-go están ahora en ✅.
