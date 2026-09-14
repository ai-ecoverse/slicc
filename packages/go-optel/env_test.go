package optel

import "testing"

func TestResolveRatePrefersEnvOverride(t *testing.T) {
	env := map[string]string{EnvRateKey: "on"}
	if got := ResolveRate("high", env); got != "on" {
		t.Fatalf("ResolveRate = %q, want %q", got, "on")
	}
}

func TestResolveRateFallsBackToExplicit(t *testing.T) {
	env := map[string]string{}
	if got := ResolveRate("high", env); got != "high" {
		t.Fatalf("ResolveRate = %q, want %q", got, "high")
	}
}

func TestResolveRateEmptyEnvValueDoesNotOverride(t *testing.T) {
	env := map[string]string{EnvRateKey: ""}
	if got := ResolveRate("low", env); got != "low" {
		t.Fatalf("ResolveRate = %q, want %q", got, "low")
	}
}

func TestResolveDebug(t *testing.T) {
	cases := map[string]bool{
		"1":     true,
		"true":  true,
		"TRUE":  true,
		"on":    true,
		"yes":   true,
		"0":     false,
		"false": false,
		"off":   false,
		"":      false,
	}
	for value, want := range cases {
		env := map[string]string{EnvDebugKey: value}
		if got := ResolveDebug(env); got != want {
			t.Errorf("ResolveDebug(%q) = %v, want %v", value, got, want)
		}
	}
	if got := ResolveDebug(map[string]string{}); got != false {
		t.Fatalf("ResolveDebug(missing) = %v, want false", got)
	}
}
