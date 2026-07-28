package main

import (
	"os"
	"time"

	optel "github.com/ai-ecoverse/go-optel"
	"github.com/ai-ecoverse/slicc-cli/internal/update"
)

// telemetryAppID is the beacon `referer` hostname — a fixed, non-identifying
// label, never a per-machine or per-user value. See docs/operational-telemetry.md.
const telemetryAppID = "slicc-cli"

// knownSubcommands allowlists the subcommand names that may travel as a
// launch beacon's `source`. sub is user-typed (a mistyped subcommand is
// still whatever the user typed), so anything outside this fixed
// vocabulary is folded into "unknown" rather than echoed verbatim — the
// same allowlist-not-passthrough posture telemetry.ts uses for the
// webapp's `fill` (shell command name) checkpoint.
var knownSubcommands = map[string]bool{
	"prompt": true, "exec": true, "watch": true, "follow": true, "update": true,
}

func classifySubcommand(sub string) string {
	if knownSubcommands[sub] {
		return sub
	}
	return "unknown"
}

// telemetryClient is the process-wide go-optel client. nil whenever
// telemetry is disabled (opt-out env var or a non-release build) or before
// initTelemetry has run; every *optel.Client method is a safe no-op on a
// nil receiver, so call sites never need to guard this.
var telemetryClient *optel.Client

// initTelemetry configures telemetry — one launch, one sampling decision,
// matching go-optel's per-process (not per-event) sampling model — and
// fires the Enter checkpoint for sub. Returns a bounded flush func to
// defer: Go has no `navigator.sendBeacon` guarantee that an in-flight
// beacon goroutine survives past main() returning.
//
// Opt-out: SLICC_NO_TELEMETRY=1. Gated to stamped release builds only,
// mirroring the update notifier's update.IsReleaseVersion gate — a `dev` /
// git-describe local build never phones home, by construction, so local
// development is always silent without needing the env var at all.
func initTelemetry(sub string) func() {
	noop := func() {}
	if !telemetryEnabled(version, os.Getenv("SLICC_NO_TELEMETRY")) {
		return noop
	}
	telemetryClient = optel.Configure(telemetryAppID, optel.Options{})
	telemetryClient.Sample(optel.Enter, classifySubcommand(sub), "")
	return func() { telemetryClient.Flush(2 * time.Second) }
}

// telemetryEnabled is the pure decision initTelemetry acts on, factored out
// so it can be exhaustively unit-tested without ever calling
// optel.Configure (and therefore without any risk of a test triggering a
// real network call).
func telemetryEnabled(ver, noTelemetryEnv string) bool {
	if noTelemetryEnv != "" {
		return false
	}
	return update.IsReleaseVersion(ver)
}

// reportRuntimeError fires an Error checkpoint for an operational failure
// (connectivity, self-update). source must be a fixed, caller-chosen label
// — never user-typed input (join URLs, exec/prompt text, or file paths).
// The message itself is sanitized inside optel.Client.ReportError: URLs
// (which may embed a join-URL bearer token) and filesystem paths are
// redacted before any truncation runs. No-op when err is nil or telemetry
// is disabled/unconfigured (nil telemetryClient).
func reportRuntimeError(source string, err error) {
	telemetryClient.ReportError(source, err)
}
