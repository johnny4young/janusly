# Bench de regresión (k6)

Corridas secuenciales de 20s por escenario contra el binario Go en la
máquina local (`make bench`). La serie completa vive en `series.jsonl`;
cada fila compara la última corrida contra la anterior.

**Cómo leer la tabla:** la columna *Dirección* dice qué significa un
número más grande — `↑ mejor` (rendimiento: más es mejor) o `↓ mejor`
(latencia y errores: menos es mejor). *Δ* es el cambio relativo frente a
la corrida anterior; *Veredicto* ya aplica la dirección por ti.

**Ruido esperado:** cada corrida agranda la base de datos (~10k filas de
runs/nodos), así que corridas consecutivas no son idénticas; deltas de
hasta ±20% en rendimiento pueden ser ruido de crecimiento o térmico.
Una regresión real se confirma con dos corridas seguidas en la misma
dirección o un cambio de más del 25%.

Última corrida: 2026-07-31T06:30:06.816Z @ `5b176113` · anterior: 2026-07-31T05:31:02.000Z @ `d1c2605e`

| Métrica | Dirección | Última | Anterior | Δ | Veredicto |
|---|---|---|---|---|---|
| start: runs terminados/s | ↑ mejor | 209 runs/s | 190 runs/s | +9.9% | ✅ mejora |
| start: latencia p50 | ↓ mejor | 47.0 ms | 48.0 ms | -2.1% | ≈ igual |
| start: latencia p95 | ↓ mejor | 51.0 ms | 73.0 ms | -30.1% | ✅ mejora |
| start: latencia p99 | ↓ mejor | 69.2 ms | 82.0 ms | -15.6% | ✅ mejora |
| list: lecturas/s | ↑ mejor | 6698 req/s | 1536 req/s | +336.1% | ✅ mejora |
| list: latencia p95 | ↓ mejor | 10.0 ms | 46.0 ms | -78.3% | ✅ mejora |
| diamond: DAGs terminados/s | ↑ mejor | 112 runs/s | 85.0 runs/s | +32.4% | ✅ mejora |
| diamond: latencia p95 | ↓ mejor | 134 ms | 190 ms | -29.7% | ✅ mejora |
| errores (todas las fases) | ↓ mejor | 0.0 | 0.0 | — | — |

Historial: 4 corrida(s) en `series.jsonl`.
