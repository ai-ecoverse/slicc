package main

import (
	"os"
	"time"

	optel "github.com/ai-ecoverse/go-optel"
	"github.com/ai-ecoverse/slicc-cli/internal/update"
)



const telemetryAppID = "slicc-cli"







var knownSubcommands = map[string]bool{
	"prompt": true, "exec": true, "watch": true, "follow": true, "update": true,
	"new-session": true, "model": true,
	"list-sessions": true, "follow-cloud": true, "prompt-cloud": true,
	"exec-cloud": true, "watch-cloud": true,
}

func classifySubcommand(sub string) string {
	if knownSubcommands[sub] {
		return sub
	}
	return "unknown"
}





var telemetryClient *optel.Client











func initTelemetry(sub string) func() {
	noop := func() {}
	if !telemetryEnabled(version, os.Getenv("SLICC_NO_TELEMETRY")) {
		return noop
	}
	telemetryClient = optel.Configure(telemetryAppID, optel.Options{})
	telemetryClient.Sample(optel.Enter, classifySubcommand(sub), "")
	return func() { telemetryClient.Flush(2 * time.Second) }
}





func telemetryEnabled(ver, noTelemetryEnv string) bool {
	if noTelemetryEnv != "" {
		return false
	}
	return update.IsReleaseVersion(ver)
}








func reportRuntimeError(source string, err error) {
	telemetryClient.ReportError(source, err)
}
