// Pure helpers for the cron-observability heatmap (reference
// schedule-history.ts): bucket scheduled-fire timestamps into a UTC
// day-of-week × hour-of-day grid, flag anomalous cells, and preview the
// next-N fires from an expression. Zero I/O — the API route composes this
// over the SQL fire history.
package cron

import "time"

const (
	MaxHistoryDays = 90
	MaxFireRows    = 5_000
	NextFiresCount = 5
)

// Fire is one observed scheduled run.
type Fire struct {
	At     time.Time
	Status string
}

// HeatmapCell is one (dayOfWeek, hour) bucket.
type HeatmapCell struct {
	DayOfWeek int  `json:"dayOfWeek"`
	Hour      int  `json:"hour"`
	Total     int  `json:"total"`
	Failed    int  `json:"failed"`
	Anomaly   bool `json:"anomaly"`
}

// BuildHeatmap buckets fires (UTC) and flags cells whose failure rate
// diverges sharply above the window's overall rate. Conservative: a
// healthy schedule and a uniformly-failing one both flag nothing.
func BuildHeatmap(fires []Fire) []HeatmapCell {
	if len(fires) > MaxFireRows {
		fires = fires[:MaxFireRows]
	}
	type key struct{ day, hour int }
	totals := map[key]*HeatmapCell{}
	overallTotal, overallFailed := 0, 0
	for _, fire := range fires {
		at := fire.At.UTC()
		cellKey := key{int(at.Weekday()), at.Hour()}
		cell, present := totals[cellKey]
		if !present {
			cell = &HeatmapCell{DayOfWeek: cellKey.day, Hour: cellKey.hour}
			totals[cellKey] = cell
		}
		cell.Total++
		overallTotal++
		if fire.Status == "failed" {
			cell.Failed++
			overallFailed++
		}
	}
	overallRate := 0.0
	if overallTotal > 0 {
		overallRate = float64(overallFailed) / float64(overallTotal)
	}
	cells := make([]HeatmapCell, 0, len(totals))
	for _, cell := range totals {
		cell.Anomaly = isAnomalousCell(cell.Total, cell.Failed, overallRate)
		cells = append(cells, *cell)
	}
	return cells
}

// isAnomalousCell: enough samples AND a failure rate far above baseline.
func isAnomalousCell(total, failed int, overallRate float64) bool {
	if total < 3 || failed == 0 {
		return false
	}
	rate := float64(failed) / float64(total)
	return rate >= 0.5 && rate >= overallRate*2 && rate-overallRate >= 0.25
}

// NextFires previews the next N fires of an expression after `from`.
func NextFires(expression string, from time.Time, count int) []time.Time {
	schedule, err := Parse(expression)
	if err != nil {
		return nil
	}
	if count <= 0 || count > 20 {
		count = NextFiresCount
	}
	fires := make([]time.Time, 0, count)
	cursor := from
	for len(fires) < count {
		next, err := schedule.Next(cursor)
		if err != nil {
			break
		}
		fires = append(fires, next)
		cursor = next
	}
	return fires
}
