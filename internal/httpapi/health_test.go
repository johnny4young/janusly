package httpapi

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestQueueHealthCacheKeepsSuccessfulSnapshotsForFiveSeconds(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	reads := 0
	cache := queueHealthCache{
		now: func() time.Time { return now },
		read: func(context.Context) (*queueSnapshot, error) {
			reads++
			return &queueSnapshot{Waiting: reads}, nil
		},
	}

	first := cache.get(context.Background())
	if first == nil || first.Waiting != 1 || reads != 1 {
		t.Fatalf("first snapshot = %+v after %d reads, want waiting=1 after one read", first, reads)
	}
	now = now.Add(queueSnapshotTTL - time.Nanosecond)
	cached := cache.get(context.Background())
	if cached != first || reads != 1 {
		t.Fatalf("success before TTL was refreshed: snapshot=%+v reads=%d", cached, reads)
	}
	now = now.Add(time.Nanosecond)
	refreshed := cache.get(context.Background())
	if refreshed == nil || refreshed.Waiting != 2 || reads != 2 {
		t.Fatalf("success at TTL was not refreshed: snapshot=%+v reads=%d", refreshed, reads)
	}
}

func TestQueueHealthCacheRetriesFailureAfterOneSecond(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	reads := 0
	cache := queueHealthCache{
		now: func() time.Time { return now },
		read: func(context.Context) (*queueSnapshot, error) {
			reads++
			if reads == 1 {
				return nil, errors.New("transient queue read timeout")
			}
			return &queueSnapshot{Active: 3}, nil
		},
	}

	if snapshot := cache.get(context.Background()); snapshot != nil || reads != 1 {
		t.Fatalf("failed read = %+v after %d reads, want nil after one read", snapshot, reads)
	}
	now = now.Add(queueSnapshotFailureTTL - time.Nanosecond)
	if snapshot := cache.get(context.Background()); snapshot != nil || reads != 1 {
		t.Fatalf("failure before short TTL was retried: snapshot=%+v reads=%d", snapshot, reads)
	}
	now = now.Add(time.Nanosecond)
	recovered := cache.get(context.Background())
	if recovered == nil || recovered.Active != 3 || reads != 2 {
		t.Fatalf("failure at short TTL did not recover: snapshot=%+v reads=%d", recovered, reads)
	}

	// A successful recovery immediately returns to the normal five-second TTL.
	now = now.Add(queueSnapshotFailureTTL)
	if cached := cache.get(context.Background()); cached != recovered || reads != 2 {
		t.Fatalf("recovered success did not use normal TTL: snapshot=%+v reads=%d", cached, reads)
	}
}
