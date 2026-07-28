package main

import (
	"errors"
	"testing"
)

func TestClassifySubcommand(t *testing.T) {
	cases := map[string]string{
		"prompt": "prompt",
		"exec":   "exec",
		"watch":  "watch",
		"follow": "follow",
		"update": "update",
		"bogus":  "unknown",
		"":       "unknown",
	}
	for sub, want := range cases {
		if got := classifySubcommand(sub); got != want {
			t.Errorf("classifySubcommand(%q) = %q, want %q", sub, got, want)
		}
	}
}

func TestTelemetryEnabled(t *testing.T) {
	cases := []struct {
		name        string
		version     string
		noTelemetry string
		want        bool
	}{
		{"dev build", "dev", "", false},
		{"git-describe build", "v5.71.1-4-gabc123", "", false},
		{"release, no opt-out", "v5.71.1", "", true},
		{"release, opted out", "v5.71.1", "1", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := telemetryEnabled(tc.version, tc.noTelemetry); got != tc.want {
				t.Errorf("telemetryEnabled(%q, %q) = %v, want %v", tc.version, tc.noTelemetry, got, tc.want)
			}
		})
	}
}

// withTelemetryGlobals saves/restores the two package-level globals
// initTelemetry / reportRuntimeError mutate, so these tests can't leak
// state into main_test.go's TestRunArgDispatch or each other.
func withTelemetryGlobals(t *testing.T) {
	t.Helper()
	origVersion, origClient := version, telemetryClient
	t.Cleanup(func() { version, telemetryClient = origVersion, origClient })
}

func TestInitTelemetryNoopWhenDisabled(t *testing.T) {
	withTelemetryGlobals(t)
	version = "dev"
	telemetryClient = nil

	flush := initTelemetry("prompt")
	flush() // must not panic even though telemetryClient stays nil
	if telemetryClient != nil {
		t.Fatal("expected telemetryClient to stay nil for a dev build")
	}
}

func TestInitTelemetryOptOutEvenOnReleaseBuild(t *testing.T) {
	withTelemetryGlobals(t)
	t.Setenv("SLICC_NO_TELEMETRY", "1")
	version = "v5.71.1"
	telemetryClient = nil

	initTelemetry("prompt")()
	if telemetryClient != nil {
		t.Fatal("expected telemetryClient to stay nil when SLICC_NO_TELEMETRY is set")
	}
}

func TestInitTelemetryConfiguresOnReleaseBuildWithoutNetworkCall(t *testing.T) {
	withTelemetryGlobals(t)
	// Force weight=0 so Sample() is a guaranteed no-op: this proves the
	// wiring configures a client and fires Enter without ever risking a
	// real network call — hermetic by construction, matching this
	// module's "no network in tests" rule.
	t.Setenv("OPTEL_RATE", "off")
	version = "v5.71.1"
	telemetryClient = nil

	flush := initTelemetry("prompt")
	if telemetryClient == nil {
		t.Fatal("expected a configured telemetryClient for a release build")
	}
	flush()
}

func TestReportRuntimeErrorNilSafety(t *testing.T) {
	withTelemetryGlobals(t)
	telemetryClient = nil

	// Neither of these may panic: nil client, and nil error on a nil client.
	reportRuntimeError("dial", nil)
	reportRuntimeError("dial", errors.New("boom"))
}
