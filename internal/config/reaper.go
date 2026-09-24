package config

import (
	"math"
	"time"
)

// Leave one second for a drill to age its synthetic claim past the same
// threshold without overflowing time.Duration. Do not clamp long-lived
// production workflows to a separate, shorter drill-only threshold.
const maxReaperMilliseconds = (math.MaxInt64 / int64(time.Millisecond)) - 1000

// Reaper is a boot-time process setting, never an organization override.
// Load validates it before either composition root starts background work.
type Reaper struct {
	Interval        time.Duration
	Threshold       time.Duration
	Floor           time.Duration
	FloorOverridden bool
}

func DefaultReaper() Reaper {
	return Reaper{Interval: time.Minute, Threshold: time.Hour, Floor: 15 * time.Minute}
}

func (r Reaper) EffectiveThreshold() time.Duration { return max(r.Threshold, r.Floor) }
