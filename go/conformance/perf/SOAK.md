# Soak — última corrida

- runId: ms93b5as
- duración: 2m (muestras cada 10s, 14 muestras)
- k6: ok
- veredicto: **CRECIÓ — investigar antes de promover**

Comparación primer cuarto vs último cuarto de la corrida (una carga
sostenida con crecimiento >10% entre extremos señala fuga; el arranque
caliente queda absorbido por el promedio del primer cuarto).

| Señal | Primer cuarto | Último cuarto | Δ | Dirección |
| --- | --- | --- | --- | --- |
| RSS | 31.0 MB | 34.5 MB | 11.5% | ▲ creció |
| Goroutines | 38 | 37 | -2.6% | ◆ estable |
| Heap in use | 7.9 MB | 9.4 MB | 20.0% | ▲ creció |

Serie completa: `soak-ms93b5as.jsonl`.
