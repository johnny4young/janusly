# Soak — latest reviewed run

- run ID: msas0wmu
- duration: 24h (samples every 60s, 1,412 samples)
- k6: ok
- automated verdict: **GROWTH FLAG — investigated below**
- reviewed verdict: **STABLE — no leak**

First-quarter versus last-quarter comparison. The automated detector flags
more than 10% growth between the endpoints; averaging the first quarter is
intended to absorb warm-up.

| Signal | First quarter | Last quarter | Δ | Direction |
| --- | --- | --- | --- | --- |
| RSS | 36.3 MB | 32.9 MB | -9.4% | ▼ lower |
| Goroutines | 41 | 41 | -0.7% | ◆ stable |
| Heap in use | 7.1 MB | 8.8 MB | 24.4% | ▲ higher |

Complete series: `soak-2026-08-01-24h.jsonl` (SHA-256
`854215d3e641fc97c04c79baf6eaa30b457b1ae71222132cac3fe5b9488a3896`).

## Reviewed investigation (2026-08-02)

The automatic verdict flagged the 24.4% heap difference between the first and
last quarters. Inspection of the complete series shows that this is a baseline
artifact, not a leak:

- Heap by eighth: 8.7 · **5.5** · 8.8 · 8.9 · 8.9 · 8.8 · 8.8 · 8.9 MiB.
  It remained near 8.8 MiB for the last ~18 hours. The second eighth fell to
  5.5 MiB when the host PostgreSQL outage and the benchmark SIGSTOP windows
  froze load. That depressed the first-quarter baseline; the tail did not
  grow.
- RSS trended down (35.5 → 32.8 MiB by eighth; 28.0 MiB final). The global
  42.5 MiB peak occurred in sample 2 during startup.
- Goroutines remained flat at approximately 41 (range 28–54, consistent with
  ordinary worker churn).

Reviewed conclusion: **STABLE — no leak**. The detector must exclude intervals
where load is frozen or its dependency is unavailable before comparing endpoint
quarters. That detector correction remains a future harness improvement; the
raw series is retained so this conclusion can be independently recalculated.
