package optel

import (
	"os"
	"strings"
)

// EnvRateKey / EnvDebugKey are the environment variables honored uniformly
// across every go-optel-based binary (same names as swift-optel's
// OptelEnvConfig).
const (
	EnvRateKey  = "OPTEL_RATE"
	EnvDebugKey = "OPTEL_DEBUG"
)

// ResolveRate resolves the effective sampling rate string. environment, when
// non-nil, is consulted instead of the process environment (tests only);
// production callers pass nil. The env override wins when set and
// non-empty; otherwise explicit is returned unchanged (which may itself be
// "", yielding DefaultWeight downstream in NewSamplingConfig).
func ResolveRate(explicit string, environment map[string]string) string {
	if v, ok := lookupEnv(EnvRateKey, environment); ok && v != "" {
		return v
	}
	return explicit
}

// ResolveDebug resolves the debug-logging flag from the environment.
// Truthy values are 1/true/on/yes (case-insensitive); anything else
// (including 0/false/off/no, empty, or missing) is false.
func ResolveDebug(environment map[string]string) bool {
	v, ok := lookupEnv(EnvDebugKey, environment)
	if !ok {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "on", "yes":
		return true
	default:
		return false
	}
}

// lookupEnv reads key from environment when non-nil (tests), else from the
// process environment.
func lookupEnv(key string, environment map[string]string) (string, bool) {
	if environment != nil {
		v, ok := environment[key]
		return v, ok
	}
	return os.LookupEnv(key)
}
