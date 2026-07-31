# Puerta D15 — informe de decisión del piloto Go

Fecha: 2026-07-30 · Rama: `go-pilot` (24 commits) · Pin: `develop @ 0f294ad2`
La decisión es de Johnny; este informe la deja lista.

## Las cuatro condiciones (§8 del plan)

### 1. F01–F10 sin divergencias no documentadas — ✅ CUMPLIDA

Las diez fixtures (once corridas) proyectan idéntico a los goldens del
stack Node real: lineal, ambas ramas condicionales, http→transform, 500
persistente→DLQ, **fallo→dlq→redrive→éxito**, **approval→resume**,
wait_until, defaults de trigger, diamante, template no resuelto. UNA
divergencia, documentada con su porqué (attempts tras redrive — decisión
de producto pendiente para F2). `make parity` reproducible.

### 2. Lanes B y C verdes; demo MCP — ✅ CUMPLIDA (demo manual pendiente)

- Lane B: e2e contra el binario COMPILADO en puertos efímeros — los dos
  ciclos del README completos, con drain de SIGTERM verificado por corrida.
- Lane C: MCP server en proceso con el SDK oficial; el e2e ES la
  conversación de agente scriptada (fallo→redrive con isError legibles).
- Pendiente no bloqueante: la demo manual con Claude real (snippet listo en
  `go/README.md`; anotar en journal al correrla).

### 3. Números propios que le importen al producto — ✅ CUMPLIDA

| Métrica de producto | Go | Node |
| --- | --- | --- |
| Runs/s a 10 VUs (p50 start→terminal) | **187.9 (34.6ms)** | 45.9 (195.9ms) |
| Lecturas del Activity feed (RPS) | **2800** | 1085 |
| Huella idle | **21.9 MB, 1 proceso, sin Redis** | ~101 MB api+worker + Redis |
| Fiabilidad del fan-in bajo carga | **4100/4100** | 443/445 (2 atascados) |

Con su asterisco honesto: a 50 VUs el pool Go degrada feo (sospechoso
concreto: `MaxConns 10` fijo; follow-up definido), donde BullMQ degrada con
gracia — lección de diseño a incorporar, no razón de parada.

### 4. Journal sin fricción prohibitiva — ✅ CUMPLIDA

Veredicto en [`JOURNAL-F0.md`](JOURNAL-F0.md) §7: la semántica JS se
escribe UNA vez por gramática (ya están); las 271 rutas restantes son
volumen con patrón establecido (ruta→handler→golden), no riesgo nuevo. El
riesgo que el piloto debía retirar — ¿la cola Postgres propia sostiene la
semántica de Node? — está retirado con paridad medida.

## Lo que el piloto regaló de vuelta a la referencia

Dos bugs candidatos reportados (chips): la gramática de paréntesis y el
run atascable por ordering del readiness scan (con reproducción probable
bajo carga: 2/445 diamantes de Node nunca completaron). Más los goldens
versionados como documentación ejecutable del contrato del API.

## Recomendación

**Continuar a rewrite por fases** (F1 lectura UI → F2 paridad completa →
F3 switchover), sujeto a los ≥2 criterios estratégicos del análisis
(`20260729-go-migration-analysis.md` §7) que solo Johnny puede pesar
(apetito de mantenimiento dual durante F1–F3, prioridad del факт
single-binary/self-host en el roadmap comercial).

Condiciones técnicas de la recomendación:

1. **F0.5 corto antes de F1** (≤2 días): pool de DB configurable + pools
   separados API/workers + retest de los escenarios 50 VU; recaptura de los
   dos goldens que fallaron (save-éxito, dlq-replay); demo MCP manual.
2. F1 usa los goldens como contrato: el web de Node apuntado al Go debe
   pasar sin tolerancias (los NULL explícitos ya lo preparan).
3. La tabla de divergencias es contrato vivo: nada entra sin porqué escrito.

Si la decisión es detener: la rama queda auto-contenida (plan, journal,
goldens, números) como evidencia y semillero — borrarla no destruye
conocimiento, está consolidado en los documentos.
