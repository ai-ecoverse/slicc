package optel

import (
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

// recordingTransport is a Transport test double that records every Event
// synchronously (no goroutine), so assertions don't need to poll.
type recordingTransport struct {
	mu     sync.Mutex
	events []Event
}

func (r *recordingTransport) Send(event Event, _ string, wg *sync.WaitGroup) {
	r.mu.Lock()
	r.events = append(r.events, event)
	r.mu.Unlock()
	if wg != nil {
		wg.Add(1)
		wg.Done()
	}
}

func (r *recordingTransport) snapshot() []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Event, len(r.events))
	copy(out, r.events)
	return out
}

func TestClientSampleAutoEmitsTopThenCheckpoint(t *testing.T) {
	rec := &recordingTransport{}
	c := Configure("slicc-cli", Options{
		Rate:         "on", // weight 1: always selected
		Transport:    rec,
		RandomSource: fakeRandom(0),
	})
	c.Sample(Enter, "prompt", "")

	events := rec.snapshot()
	if len(events) != 2 {
		t.Fatalf("expected 2 events (auto top + enter), got %d: %+v", len(events), events)
	}
	if events[0].Checkpoint != Top || events[0].T != 0 {
		t.Errorf("first event = %+v, want top/t=0", events[0])
	}
	if events[1].Checkpoint != Enter || events[1].Source != "prompt" {
		t.Errorf("second event = %+v, want enter/source=prompt", events[1])
	}
	if events[0].ID != events[1].ID || events[0].Weight != events[1].Weight {
		t.Errorf("events do not share session id/weight: %+v", events)
	}
}

func TestClientSampleOnlyAutoEmitsTopOnce(t *testing.T) {
	rec := &recordingTransport{}
	c := Configure("slicc-cli", Options{Rate: "on", Transport: rec, RandomSource: fakeRandom(0)})
	c.Sample(Enter, "prompt", "")
	c.Sample(Error, "dial", "connection refused")

	events := rec.snapshot()
	if len(events) != 3 {
		t.Fatalf("expected 3 events (one top + two checkpoints), got %d: %+v", len(events), events)
	}
	topCount := 0
	for _, e := range events {
		if e.Checkpoint == Top {
			topCount++
		}
	}
	if topCount != 1 {
		t.Fatalf("expected exactly one top event, got %d", topCount)
	}
}

func TestClientSampleUnselectedSessionSendsNothing(t *testing.T) {
	rec := &recordingTransport{}
	c := Configure("slicc-cli", Options{Rate: "off", Transport: rec})
	c.Sample(Enter, "prompt", "")
	if len(rec.snapshot()) != 0 {
		t.Fatalf("weight=0 session must send nothing, got %+v", rec.snapshot())
	}
}

func TestClientReportErrorSanitizes(t *testing.T) {
	rec := &recordingTransport{}
	c := Configure("slicc-cli", Options{Rate: "on", Transport: rec, RandomSource: fakeRandom(0)})
	c.ReportError("dial", errors.New(`Get "https://sliccy.ai/join/leaked-secret": connection refused`))

	events := rec.snapshot()
	last := events[len(events)-1]
	if last.Checkpoint != Error || last.Source != "dial" {
		t.Fatalf("unexpected error event: %+v", last)
	}
	if strings.Contains(last.Target, "leaked-secret") {
		t.Fatalf("ReportError leaked the join token into the target field: %q", last.Target)
	}
}

func TestClientReportErrorNilErrorIsNoop(t *testing.T) {
	rec := &recordingTransport{}
	c := Configure("slicc-cli", Options{Rate: "on", Transport: rec, RandomSource: fakeRandom(0)})
	c.ReportError("dial", nil)
	if len(rec.snapshot()) != 0 {
		t.Fatalf("nil error must not emit a beacon, got %+v", rec.snapshot())
	}
}

func TestNilClientIsInertNoop(_ *testing.T) {
	var c *Client
	// None of these may panic.
	c.Sample(Enter, "prompt", "")
	c.ReportError("dial", errors.New("boom"))
	c.Flush(10 * time.Millisecond)
}

func TestClientFlushWaitsForInFlightBeacons(t *testing.T) {
	slow := &blockingTransport{release: make(chan struct{})}
	c := Configure("slicc-cli", Options{Rate: "on", Transport: slow, RandomSource: fakeRandom(0)})
	c.Sample(Enter, "prompt", "")

	flushed := make(chan struct{})
	go func() {
		c.Flush(2 * time.Second)
		close(flushed)
	}()

	select {
	case <-flushed:
		t.Fatal("Flush returned before the in-flight beacon was released")
	case <-time.After(100 * time.Millisecond):
	}

	close(slow.release)
	select {
	case <-flushed:
	case <-time.After(2 * time.Second):
		t.Fatal("Flush did not return after the beacon was released")
	}
}

func TestClientFlushTimesOutBoundedly(t *testing.T) {
	slow := &blockingTransport{release: make(chan struct{})}
	defer close(slow.release)
	c := Configure("slicc-cli", Options{Rate: "on", Transport: slow, RandomSource: fakeRandom(0)})
	c.Sample(Enter, "prompt", "")

	start := time.Now()
	c.Flush(50 * time.Millisecond)
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("Flush did not honor its timeout, took %s", elapsed)
	}
}

// blockingTransport holds every Send's wg.Done() until release is closed,
// simulating a slow network call for Flush timeout tests.
type blockingTransport struct {
	release chan struct{}
}

func (b *blockingTransport) Send(_ Event, _ string, wg *sync.WaitGroup) {
	if wg != nil {
		wg.Add(1)
		go func() {
			<-b.release
			wg.Done()
		}()
	}
}
