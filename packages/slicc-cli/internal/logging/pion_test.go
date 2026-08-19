package logging

import (
	"fmt"
	"io"
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
		nil,
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

	// The logger takes every level; the event tap is for link problems only, so
	// pion's running commentary (trace/debug/info) never reaches it.
	if len(lines) != 10 {
		t.Fatalf("routed %d lines, want 10: %v", len(lines), lines)
	}
	if !strings.HasPrefix(lines[0], "pion turnc: ") {
		t.Errorf("record %q is missing the scope prefix", lines[0])
	}
	wantLevels := []slog.Level{
		slog.LevelWarn, slog.LevelWarn, slog.LevelError, slog.LevelError,
	}
	if len(events) != len(wantLevels) {
		t.Fatalf("tapped %d events, want %d: %v", len(events), len(wantLevels), events)
	}
	for i, want := range wantLevels {
		if events[i].level != want {
			t.Errorf("event %d level = %v, want %v", i, events[i].level, want)
		}
		if events[i].scope != "turnc" {
			t.Errorf("event %d scope = %q, want turnc", i, events[i].scope)
		}
	}
	if events[1].msg != "w1" {
		t.Errorf("formatted message = %q, want w1", events[1].msg)
	}
}

func TestPionFactoryWithNoSinksIsSilent(_ *testing.T) {
	// Nothing consumes the records, so nothing should be formatted either —
	// pion traces every STUN packet at trace level.
	log := PionFactory(nil, nil, nil).NewLogger("ice")
	log.Errorf("%s", panicOnFormat{})
	log.Error("plain")
}

func TestPionFactoryEventOnlyStillFires(t *testing.T) {
	var got int
	log := PionFactory(nil, func(string, slog.Level, string) { got++ }, nil).NewLogger("sctp")
	log.Warnf("dropped %d", 3)
	if got != 1 {
		t.Errorf("event fired %d times, want 1", got)
	}
}

func TestPionFactoryThroughTheDiagnosticLogger(t *testing.T) {
	var buf strings.Builder
	logger := New(&buf, Config{Enabled: true, Level: slog.LevelDebug})
	PionFactory(logger.Logf, nil, logger.EnabledAt).NewLogger("turnc").
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
	PionFactory(logger.Logf, nil, logger.EnabledAt).NewLogger("turnc").Error("Fail to refresh permissions")
	if buf.String() != "" {
		t.Errorf("a disabled logger must emit nothing, got %q", buf.String())
	}
}

// panicOnFormat panics if anything formats it, proving the format is skipped.
type panicOnFormat struct{}

func (panicOnFormat) String() string { panic("formatted a record nobody consumes") }

func TestPionFactorySkipsFormattingForALoggerThatWouldDropIt(t *testing.T) {
	// The production wiring: logf is a live closure over a logger that is off by
	// default, and the event tap is always installed. pion still calls Tracef per
	// STUN packet, so the record must die before it is formatted.
	logger := New(io.Discard, Config{})
	log := PionFactory(logger.Logf, func(string, slog.Level, string) {}, logger.EnabledAt).NewLogger("ice")
	log.Tracef("%s", panicOnFormat{})
	log.Debugf("%s", panicOnFormat{})
	log.Infof("%s", panicOnFormat{})

	// Warn and above still reach the tap, so those are formatted.
	var got string
	tapped := PionFactory(logger.Logf, func(_ string, _ slog.Level, msg string) { got = msg }, logger.EnabledAt).
		NewLogger("turnc")
	tapped.Errorf("Fail to refresh permissions: %s", "broken pipe")
	if got != "Fail to refresh permissions: broken pipe" {
		t.Errorf("tapped %q, want the formatted record", got)
	}
}

func TestPionFactoryFormatsWhatTheLoggerAsksFor(t *testing.T) {
	// SLICC_DEBUG=1: now the trace records are wanted, and nothing may swallow
	// them.
	var buf strings.Builder
	logger := New(&buf, Config{Enabled: true, Level: slog.LevelDebug})
	PionFactory(logger.Logf, nil, logger.EnabledAt).NewLogger("ice").Tracef("candidate %d", 7)
	if !strings.Contains(buf.String(), "pion ice: candidate 7") {
		t.Errorf("debug output %q dropped a wanted trace record", buf.String())
	}
}

func TestEnabledAtFollowsTheConfiguredLevel(t *testing.T) {
	warn := New(io.Discard, Config{Enabled: true, Level: slog.LevelWarn})
	if warn.EnabledAt(slog.LevelDebug) {
		t.Error("a warn logger claims to want debug records")
	}
	if !warn.EnabledAt(slog.LevelError) {
		t.Error("a warn logger refuses error records")
	}
	var off *Logger
	if off.EnabledAt(slog.LevelError) {
		t.Error("a nil logger claims to want records")
	}
}
