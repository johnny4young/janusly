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

Última corrida: 2026-08-01T20:18:45.612Z @ `52e4825e` · anterior: 2026-08-01T20:16:59.358Z @ `52e4825e`

| Métrica | Dirección | Última | Anterior | Δ | Veredicto |
|---|---|---|---|---|---|
| start: runs terminados/s | ↑ mejor | 51.9 runs/s | 44.8 runs/s | +16.0% | ✅ mejora |
| start: latencia p50 | ↓ mejor | 189 ms | 184 ms | +2.7% | ≈ igual |
| start: latencia p95 | ↓ mejor | 260 ms | 527 ms | -50.7% | ✅ mejora |
| start: latencia p99 | ↓ mejor | 319 ms | 739 ms | -56.8% | ✅ mejora |
| list: lecturas/s | ↑ mejor | 2372 req/s | 258 req/s | +819.1% | ✅ mejora |
| list: latencia p95 | ↓ mejor | 28.0 ms | 305 ms | -90.8% | ✅ mejora |
| diamond: DAGs terminados/s | ↑ mejor | 42.5 runs/s | 13.0 runs/s | +226.9% | ✅ mejora |
| diamond: latencia p95 | ↓ mejor | 406 ms | 1506 ms | -73.0% | ✅ mejora |
| errores (todas las fases) | ↓ mejor | 0.0 | 0.0 | — | — |

Historial: 11 corrida(s) en `series.jsonl`.
