# Evolución de rendimiento — F0 → ola 2

Tres momentos de medición, misma máquina (M-series, Postgres local en
Docker). **Cómo leer:** la columna *Dirección* dice qué significa un número
más grande — `↑ mejor` (rendimiento) o `↓ mejor` (latencia). Las
comparaciones entre momentos son indicativas, no de laboratorio: cambia la
herramienta (loadgen propio → k6) y crece la base entre corridas.

## Contexto de cada momento

| Momento | Herramienta | Estado |
|---|---|---|
| **Node (referencia)** | loadgen propio, 2026-07-30 | api + worker + Redis, stack completo |
| **Go F0 (post-T-019)** | loadgen propio, 2026-07-30 | pools API/worker separados — el arreglo del acantilado de 50 VUs |
| **Go ola 2** | k6, 2026-07-31 | + índice keyset, timestamps ms, todos los features de la ola |

## start → terminal (10 VUs)

| Métrica | Dirección | Node | Go F0 | Go ola 2 |
|---|---|---|---|---|
| runs terminados/s | ↑ mejor | 45.9 | 187.9 | **209.0** |
| p50 | ↓ mejor | 195.9 ms | 34.6 ms | **47.0 ms** |
| p99 | ↓ mejor | 523.2 ms | 255.3 ms | **69.2 ms** |

Go ola 2 termina **4.6× más runs por segundo** que la referencia con un
p99 **7.6× menor**. El p50 subió unos ms respecto a F0 (más trabajo por
run: eventos con timestamps truncados, gate hooks) pero la cola p99 se
compactó 3.7× — la varianza es la que murió.

## list (50 VUs, org poblado)

| Métrica | Dirección | Node¹ | Go F0¹ | Go ola 2 |
|---|---|---|---|---|
| lecturas/s | ↑ mejor | 1 085 | 6 220 | **6 698** |
| p95 | ↓ mejor | 77.8 ms | 15.2 ms | **10.0 ms** |

¹ Los números Node y Go F0 listaban orgs con pocos runs; el de ola 2 lista
un org con decenas de miles (el peor caso honesto). Que aun así mejore es
obra del índice keyset alineado (`(org, created_at DESC, id DESC)`): sin
él, este escenario daba 338/s @ 150 ms.

## diamond (fan-out/fan-in, 10 VUs)

| Métrica | Dirección | Node² | Go F0 | Go ola 2 |
|---|---|---|---|---|
| DAGs terminados/s | ↑ mejor | 29.5² | 90.0 | **112.5** |
| p95 | ↓ mejor | — | 180.4 ms | **133.6 ms** |

² Node medido a 5 VUs/15s (su corrida de 10 VUs dejó 2 runs atascados —
el hallazgo de orden de declaración regalado como chip); comparación
conservadora a favor de Node.

## Huella

| Métrica | Dirección | Node | Go |
|---|---|---|---|
| RSS en reposo | ↓ mejor | ~101 MB (api+worker) + Redis | **~22 MB**, un proceso |
| RSS bajo carga | ↓ mejor | — | **~43 MB** |
| Procesos/infra | ↓ mejor | api + worker + Redis + Postgres | **binario + Postgres** |

## Veredicto de la ola

Los features de la ola 2 (gate de readiness, bounds por tenant, eventos
ms, streaming, idempotencia) **no costaron rendimiento**: el throughput
subió en los tres escenarios respecto a F0 y la cola p99 del camino
crítico se compactó. La serie continua vive en `series.jsonl` +
`BENCH.md` (`make bench`).
