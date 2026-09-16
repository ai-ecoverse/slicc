package optel

import "testing"

func TestParseWeight(t *testing.T) {
	cases := map[string]int{
		"on":     1,
		"off":    0,
		"high":   10,
		"low":    1000,
		"":       DefaultWeight,
		"100":    DefaultWeight,
		"banana": DefaultWeight,
	}
	for rate, want := range cases {
		if got := ParseWeight(rate); got != want {
			t.Errorf("ParseWeight(%q) = %d, want %d", rate, got, want)
		}
	}
}

type fakeRandom float64

func (f fakeRandom) Float64() float64 { return float64(f) }

func TestNewSessionSelection(t *testing.T) {

	s := NewSession("abc123456", SamplingConfig{Weight: 1}, fakeRandom(0.999999))
	if !s.Selected {
		t.Fatal("weight=1 must always select")
	}

	s = NewSession("abc123456", SamplingConfig{Weight: 0}, fakeRandom(0))
	if s.Selected {
		t.Fatal("weight=0 must never select")
	}

	s = NewSession("abc123456", SamplingConfig{Weight: 10}, fakeRandom(0.05))
	if !s.Selected {
		t.Fatal("draw=0.05, weight=10 (0.5 < 1) should select")
	}
	s = NewSession("abc123456", SamplingConfig{Weight: 10}, fakeRandom(0.5))
	if s.Selected {
		t.Fatal("draw=0.5, weight=10 (5 < 1 is false) should not select")
	}
}

func TestNewSessionNilRandomUsesDefault(t *testing.T) {

	s := NewSession("abc123456", SamplingConfig{Weight: 100}, nil)
	if s.ID != "abc123456" || s.Weight != 100 {
		t.Fatalf("unexpected session: %+v", s)
	}
}

func TestNewSamplingConfig(t *testing.T) {
	if got := NewSamplingConfig("high").Weight; got != 10 {
		t.Fatalf("NewSamplingConfig(high).Weight = %d, want 10", got)
	}
}
