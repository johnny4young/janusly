package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

const (
	defaultFeedbackMemoryWorkers       = 4
	defaultFeedbackMemoryQueueCapacity = 256
	defaultFeedbackMemoryTaskTimeout   = 15 * time.Second
	feedbackMemoryWorkersMax           = 32
	feedbackMemoryQueueCapacityMax     = 4096
	feedbackMemoryTaskTimeoutMin       = time.Second
	feedbackMemoryTaskTimeoutMax       = 5 * time.Minute
)

var (
	metricFeedbackMemoryAccepted = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_feedback_memory_accepted_total",
		Help: "Feedback-derived memory tasks accepted into the bounded process queue.",
	})
	metricFeedbackMemoryDropped = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_feedback_memory_dropped_total",
		Help: "Feedback-derived memory tasks explicitly discarded because intake could not accept them.",
	})
	metricFeedbackMemoryFailures = promauto.NewCounter(prometheus.CounterOpts{
		Name: "janusly_feedback_memory_failures_total",
		Help: "Accepted feedback-derived memory tasks that failed, timed out, were cancelled, or panicked.",
	})
	metricFeedbackMemoryActive = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "janusly_feedback_memory_active",
		Help: "Feedback-derived memory tasks currently executing in this process.",
	})
	metricFeedbackMemoryQueueDepth = promauto.NewGauge(prometheus.GaugeOpts{
		Name: "janusly_feedback_memory_queue_depth",
		Help: "Feedback-derived memory tasks currently waiting in bounded process queues.",
	})
	metricFeedbackMemoryDuration = promauto.NewHistogram(prometheus.HistogramOpts{
		Name:    "janusly_feedback_memory_duration_seconds",
		Help:    "Execution time of accepted feedback-derived memory tasks.",
		Buckets: prometheus.ExponentialBuckets(0.01, 2.5, 12),
	})
)

type feedbackMemoryTask func(context.Context) error

type feedbackMemoryPoolOptions struct {
	workers       int
	queueCapacity int
	taskTimeout   time.Duration
	logger        *slog.Logger
}

func validateFeedbackMemoryPoolOptions(options feedbackMemoryPoolOptions) error {
	var problems []error
	if options.workers < 1 || options.workers > feedbackMemoryWorkersMax {
		problems = append(problems, fmt.Errorf("workers must be in [1, %d]", feedbackMemoryWorkersMax))
	}
	if options.queueCapacity < 1 || options.queueCapacity > feedbackMemoryQueueCapacityMax {
		problems = append(problems, fmt.Errorf("queue capacity must be in [1, %d]", feedbackMemoryQueueCapacityMax))
	}
	if options.taskTimeout < feedbackMemoryTaskTimeoutMin || options.taskTimeout > feedbackMemoryTaskTimeoutMax {
		problems = append(problems, fmt.Errorf("task timeout must be in [%s, %s]",
			feedbackMemoryTaskTimeoutMin, feedbackMemoryTaskTimeoutMax))
	}
	return errors.Join(problems...)
}

type feedbackMemoryPoolSnapshot struct {
	accepted int64
	dropped  int64
	failed   int64
	active   int64
	depth    int64
}

// feedbackMemoryPool owns a fixed number of workers and the only sender-side
// close of its queue. The intake lock makes close versus non-blocking enqueue
// deterministic, while task contexts outlive the request that produced them.
type feedbackMemoryPool struct {
	queue       chan feedbackMemoryTask
	taskTimeout time.Duration
	logger      *slog.Logger
	root        context.Context
	cancel      context.CancelFunc

	intakeMu  sync.RWMutex
	accepting bool
	closeOnce sync.Once
	workers   sync.WaitGroup
	done      chan struct{}

	accepted atomic.Int64
	dropped  atomic.Int64
	failed   atomic.Int64
	active   atomic.Int64
	depth    atomic.Int64
}

func newFeedbackMemoryPool(options feedbackMemoryPoolOptions) (*feedbackMemoryPool, error) {
	if err := validateFeedbackMemoryPoolOptions(options); err != nil {
		return nil, err
	}
	if options.logger == nil {
		options.logger = slog.Default()
	}
	root, cancel := context.WithCancel(context.Background())
	pool := &feedbackMemoryPool{
		queue: make(chan feedbackMemoryTask, options.queueCapacity), taskTimeout: options.taskTimeout,
		logger: options.logger, root: root, cancel: cancel, accepting: true, done: make(chan struct{}),
	}
	pool.workers.Add(options.workers)
	for range options.workers {
		go pool.work()
	}
	go func() {
		pool.workers.Wait()
		close(pool.done)
	}()
	return pool, nil
}

// enqueue never blocks the feedback response. Saturation and closed intake are
// explicit optional-memory drops; neither the task nor tenant data is logged.
func (p *feedbackMemoryPool) enqueue(task feedbackMemoryTask) bool {
	if task == nil {
		p.recordDrop("invalid")
		return false
	}
	p.intakeMu.RLock()
	defer p.intakeMu.RUnlock()
	if !p.accepting {
		p.recordDrop("closed")
		return false
	}

	// Increment before the send: an already-waiting worker may receive as soon
	// as the send commits, and queue depth must never transiently go negative.
	p.depth.Add(1)
	metricFeedbackMemoryQueueDepth.Inc()
	select {
	case p.queue <- task:
		p.accepted.Add(1)
		metricFeedbackMemoryAccepted.Inc()
		return true
	default:
		p.depth.Add(-1)
		metricFeedbackMemoryQueueDepth.Dec()
		p.recordDrop("saturated")
		return false
	}
}

func (p *feedbackMemoryPool) recordDrop(reason string) {
	dropped := p.dropped.Add(1)
	metricFeedbackMemoryDropped.Inc()
	// Log the first and powers of two so sustained overload stays visible
	// without turning one overloaded tenant into a log-volume incident.
	if dropped == 1 || dropped&(dropped-1) == 0 {
		p.logger.Warn("feedback memory task dropped", "reason", reason, "dropped_total", dropped)
	}
}

func (p *feedbackMemoryPool) work() {
	defer p.workers.Done()
	for task := range p.queue {
		p.depth.Add(-1)
		metricFeedbackMemoryQueueDepth.Dec()
		if p.root.Err() != nil {
			p.recordDrop("shutdown")
			continue
		}
		p.run(task)
	}
}

func (p *feedbackMemoryPool) run(task feedbackMemoryTask) {
	p.active.Add(1)
	metricFeedbackMemoryActive.Inc()
	started := time.Now()
	defer func() {
		p.active.Add(-1)
		metricFeedbackMemoryActive.Dec()
		metricFeedbackMemoryDuration.Observe(time.Since(started).Seconds())
	}()

	taskContext, cancel := context.WithTimeout(p.root, p.taskTimeout)
	defer cancel()
	reason := ""
	func() {
		defer func() {
			if recover() != nil {
				reason = "panic"
			}
		}()
		err := task(taskContext)
		switch {
		case errors.Is(taskContext.Err(), context.DeadlineExceeded):
			reason = "timeout"
		case errors.Is(taskContext.Err(), context.Canceled):
			reason = "shutdown"
		case err != nil:
			reason = "task"
		}
	}()
	if reason != "" {
		failed := p.failed.Add(1)
		metricFeedbackMemoryFailures.Inc()
		// Deliberately omit both the error and panic value: either can contain
		// provider output or operator-authored content. Like overload logs,
		// failures are sampled at powers of two to bound log amplification.
		if failed == 1 || failed&(failed-1) == 0 {
			p.logger.Warn("feedback memory task failed", "reason", reason, "failed_total", failed)
		}
	}
}

// shutdown closes intake, drains accepted work while ctx is live, then
// cancels active work and explicitly discards queued tasks if the deadline is
// reached. It waits for every owned worker before returning so pools may close
// safely immediately afterward.
func (p *feedbackMemoryPool) shutdown(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	p.closeOnce.Do(func() {
		p.intakeMu.Lock()
		p.accepting = false
		close(p.queue)
		p.intakeMu.Unlock()
	})
	select {
	case <-p.done:
		p.cancel()
		return nil
	case <-ctx.Done():
		p.cancel()
		<-p.done
		return fmt.Errorf("drain feedback memory pool: %w", ctx.Err())
	}
}

func (p *feedbackMemoryPool) snapshot() feedbackMemoryPoolSnapshot {
	return feedbackMemoryPoolSnapshot{
		accepted: p.accepted.Load(), dropped: p.dropped.Load(), failed: p.failed.Load(),
		active: p.active.Load(), depth: p.depth.Load(),
	}
}
