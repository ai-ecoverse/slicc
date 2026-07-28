package optel

import "math/rand/v2"

// SamplingConfig is the resolved sampling weight that drives the
// once-per-process selection coin flip.
//
// Mirrors helix-rum-js and swift-optel's SamplingConfig exactly: only the
// on/off/high/low rate aliases map to a specific weight; anything else
// (including numeric strings, "", and unset) falls back to the default
// weight of 100.
type SamplingConfig struct {
	Weight int
}

// DefaultWeight is the helix-rum-js default weight used when no rate is
// supplied.
const DefaultWeight = 100

// NewSamplingConfig builds a SamplingConfig from a rate string.
func NewSamplingConfig(rate string) SamplingConfig {
	return SamplingConfig{Weight: ParseWeight(rate)}
}

// ParseWeight resolves a rate string to its integer weight, matching the
// helix-rum-js `rateValue` table.
func ParseWeight(rate string) int {
	switch rate {
	case "on":
		return 1
	case "off":
		return 0
	case "high":
		return 10
	case "low":
		return 1000
	default:
		return DefaultWeight
	}
}

// RandomSource supplies the uniform [0,1) draw used to resolve the
// once-per-session selection decision. Injectable so tests can pin the
// outcome; production code uses DefaultRandomSource.
type RandomSource interface {
	Float64() float64
}

type systemRandomSource struct{}

func (systemRandomSource) Float64() float64 { return rand.Float64() }

// DefaultRandomSource is the production RandomSource, backed by
// math/rand/v2's auto-seeded top-level generator (no manual seeding
// required since Go 1.22).
var DefaultRandomSource RandomSource = systemRandomSource{}

// Session is the per-process sampling state: the stable session id, the
// resolved weight, and the cached selection decision.
//
// Mirrors swift-optel's SamplingSession: Selected is computed once, from a
// single coin flip, and reused for every beacon this process emits — one
// decision per launch, never per event.
type Session struct {
	ID       string
	Weight   int
	Selected bool
}

// NewSession constructs a Session, computing Selected exactly once from the
// supplied RandomSource. A nil random falls back to DefaultRandomSource.
func NewSession(id string, config SamplingConfig, random RandomSource) Session {
	if random == nil {
		random = DefaultRandomSource
	}
	return Session{
		ID:       id,
		Weight:   config.Weight,
		Selected: computeSelected(config.Weight, random),
	}
}

// computeSelected is the pure selection predicate matching helix-rum-js:
// weight > 0 && random * weight < 1.
func computeSelected(weight int, random RandomSource) bool {
	if weight <= 0 {
		return false
	}
	return random.Float64()*float64(weight) < 1.0
}
