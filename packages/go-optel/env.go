package optel

import (
	"os"
	"strings"
)

const (
	EnvRateKey  = "OPTEL_RATE"
	EnvDebugKey = "OPTEL_DEBUG"
)

func ResolveRate(explicit string, environment map[string]string) string {
	if v, ok := lookupEnv(EnvRateKey, environment); ok && v != "" {
		return v
	}
	return explicit
}

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

func lookupEnv(key string, environment map[string]string) (string, bool) {
	if environment != nil {
		v, ok := environment[key]
		return v, ok
	}
	return os.LookupEnv(key)
}
