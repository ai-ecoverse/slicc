package optel

import "math/rand/v2"








type SamplingConfig struct {
	Weight int
}



const DefaultWeight = 100


func NewSamplingConfig(rate string) SamplingConfig {
	return SamplingConfig{Weight: ParseWeight(rate)}
}



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




type RandomSource interface {
	Float64() float64
}

type systemRandomSource struct{}

func (systemRandomSource) Float64() float64 { return rand.Float64() }




var DefaultRandomSource RandomSource = systemRandomSource{}







type Session struct {
	ID       string
	Weight   int
	Selected bool
}



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



func computeSelected(weight int, random RandomSource) bool {
	if weight <= 0 {
		return false
	}
	return random.Float64()*float64(weight) < 1.0
}
