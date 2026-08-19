package logging

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"testing"
)

type pionRecord struct {
	scope string
	level slog.Level
	msg   string
}

func TestPionFactoryRoutesEveryLevel(t *testing.T) {
	var mu sync.Mutex
	var lines []string
	var events []pionRecord
	factory := PionFactory(
		func(format string, args ...any) {
			mu.Lock()
			defer mu.Unlock()
			lines = append(lines, fmt.Sprintf(format, args...))
		},
		func(scope string, level slog.Level, msg string) {
			mu.Lock()
			defer mu.Unlock()
			events = append(events, pionRecord{scope, level, msg})
		},
	)

	log := factory.NewLogger("turnc")
	log.Trace("t")
	log.Tracef("t%d", 1)
	log.Debug("d")
	log.Debugf("d%d", 1)
	log.Info("i")
	log.Infof("i%d", 1)
	log.Warn("w")
	log.Warnf("w%d", 1)
	log.Error("e")
	log.Errorf("e%d", 1)

	if len(lines) != 10 || len(events) != 10 {
		t.Fatalf("routed %d lines / %d events, want 10 each", len(lines), len(events))
	}
	if !strings.HasPrefix(lines[0], "pion turnc: ") {
		t.Errorf("record %q is missing the scope prefix", lines[0])
	}
	// Levels must survive the trip; the status bar counts warnings and errors.
	wantLevels := []slog.Level{
		slog.LevelDebug, slog.LevelDebug, slog.LevelDebug, slog.LevelDebug,
		slog.LevelInfo, slog.LevelInfo, slog.LevelWarn, slog.LevelWarn,
		slog.LevelError, slog.LevelError,
	}
	for i, want := range wantLevels {
		if events[i].level != want {
			t.Errorf("event %d level = %v, want %v", i, events[i].level, want)
		}
		if events[i].scope != "turnc" {
			t.Errorf("event %d scope = %q, want turnc", i, events[i].scope)
		}
	}
	if events[1].msg != "t1" {
		t.Errorf("formatted message = %q, want t1", events[1].msg)
	}
}

func TestPionFactoryWithNoSinksIsSilent(_ *testing.T) {
	// Nothing consumes the records, so nothing should be formatted either —
	// pion traces every STUN packet at trace level.
	log := PionFactory(nil, nil).NewLogger("ice")
	log.Errorf("%s", panicOnFormat{})
	log.Error("plain")
}

func TestPionFactoryEventOnlyStillFires(t *testing.T) {
	var got int
	log := PionFactory(nil, func(string, slog.Level, string) { got++ }).NewLogger("sctp")
	log.Warnf("dropped %d", 3)
	if got != 1 {
		t.Errorf("event fired %d times, want 1", got)
	}
}

func TestPionFactoryThroughTheDiagnosticLogger(t *testing.T) {
	var buf strings.Builder
	logger := New(&buf, Config{Enabled: true, Level: slog.LevelDebug})
	PionFactory(logger.Logf, nil).NewLogger("turnc").
		Errorf("Fail to refresh permissions: %s", "broken pipe")

	out := buf.String()
	if !strings.Contains(out, "pion turnc: Fail to refresh permissions: broken pipe") {
		t.Errorf("diagnostic output %q is missing the pion record", out)
	}
}

func TestPionFactoryIsQuietWhenTheLoggerIsOff(t *testing.T) {
	// The default build has diagnostics disabled: this is what keeps TURN churn
	// off a user's terminal.
	var buf strings.Builder
	logger := New(&buf, Config{})
	PionFactory(logger.Logf, nil).NewLogger("turnc").Error("Fail to refresh permissions")
	if buf.String() != "" {
		t.Errorf("a disabled logger must emit nothing, got %q", buf.String())
	}
}

// panicOnFormat panics if anything formats it, proving the format is skipped.
type panicOnFormat struct{}

func (panicOnFormat) String() string { panic("formatted a record nobody consumes") }
