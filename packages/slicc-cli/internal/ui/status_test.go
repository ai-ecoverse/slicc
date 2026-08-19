package ui

import (
	"strings"
	"testing"
	"time"
)

var unicodeMode = Mode{Unicode: true}

func TestCompactDuration(t *testing.T) {
	cases := map[time.Duration]string{
		0:                             "0s",
		1500 * time.Millisecond:       "1s",
		59 * time.Second:              "59s",
		time.Minute + 2*time.Second:   "1m02s",
		90 * time.Minute:              "1h30m",
		25*time.Hour + 30*time.Minute: "1d01h",
		-5 * time.Second:              "0s",
	}
	for in, want := range cases {
		if got := CompactDuration(in); got != want {
			t.Errorf("CompactDuration(%s) = %q, want %q", in, got, want)
		}
	}
}

func TestStatusRenderFields(t *testing.T) {
	now := time.Date(2026, 8, 19, 12, 0, 0, 0, time.UTC)
	st := Status{
		Started:  now.Add(-2 * time.Minute),
		State:    StateConnected,
		Sessions: 3,
		Execs:    12,
		Diags:    21,
		LastBeat: now.Add(-4 * time.Second),
		Peer:     "alice@laptop · bash -c",
	}
	got := st.render(unicodeMode, now, 0, 200)
	for _, want := range []string{
		"● connected", "up 2m00s", "♥ 4s", "▸ 12 execs", "⇅ 2 reconnects", "link ⚠ 21",
		"alice@laptop · bash -c",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("bar %q is missing %q", got, want)
		}
	}
}

func TestStatusRenderOmitsEmptyFields(t *testing.T) {
	now := time.Now()
	st := Status{Started: now, State: StateConnected, Sessions: 1}
	got := st.render(unicodeMode, now, 0, 200)
	for _, unwanted := range []string{"execs", "reconnects", "link", "♥"} {
		if strings.Contains(got, unwanted) {
			t.Errorf("a fresh session must not show %q: %q", unwanted, got)
		}
	}
}

func TestStatusBadges(t *testing.T) {
	now := time.Now()
	cases := []struct {
		name string
		st   Status
		want string
	}{
		{"connecting", Status{State: StateConnecting}, "connecting"},
		{"retrying attempt", Status{State: StateConnecting, Attempt: 2}, "reconnecting (try 3)"},
		{"countdown", Status{State: StateRetrying, RetryAt: now.Add(12 * time.Second)}, "retry in 12s"},
		{"elapsed countdown", Status{State: StateRetrying, RetryAt: now.Add(-time.Second)}, "retry in 0s"},
		{"offline", Status{State: StateOffline}, "offline"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tc.st.Started = now
			if got := tc.st.render(unicodeMode, now, 0, 200); !strings.Contains(got, tc.want) {
				t.Errorf("bar %q is missing %q", got, tc.want)
			}
		})
	}
}

func TestStatusRenderNeverExceedsWidth(t *testing.T) {
	now := time.Now()
	st := Status{
		Started: now.Add(-time.Hour), State: StateConnected, Sessions: 9, Execs: 99, Diags: 999,
		LastBeat: now, Peer: "someone@a-very-long-hostname-indeed · docker exec -i sandbox sh -c",
	}
	for _, mode := range []Mode{unicodeMode, {Unicode: true, Color: true}, {}} {
		for width := 1; width <= 120; width++ {
			if got := visibleWidth(st.render(mode, now, 0, width)); got > width {
				t.Fatalf("width %d overflowed to %d cells (mode %+v)", width, got, mode)
			}
		}
	}
}

func TestStatusRenderKeepsStateWhenNarrow(t *testing.T) {
	now := time.Now()
	st := Status{Started: now, State: StateConnected, Sessions: 1, Execs: 5, Peer: "alice@laptop"}
	// The badge is the field worth keeping when there is room for one field.
	got := st.render(unicodeMode, now, 0, 12)
	if !strings.Contains(got, "connected") {
		t.Errorf("narrow bar %q dropped the state badge", got)
	}
	if strings.Contains(got, "execs") {
		t.Errorf("narrow bar %q should have dropped the later fields", got)
	}
}

func TestBeatStyleAges(t *testing.T) {
	cases := map[time.Duration]Style{
		time.Second:      StyleGreen,
		45 * time.Second: StyleYellow,
		5 * time.Minute:  StyleRed,
	}
	for age, want := range cases {
		if got := beatStyle(age); got != want {
			t.Errorf("beatStyle(%s) = %v, want %v", age, got, want)
		}
	}
}

func TestTapeWorstStateWins(t *testing.T) {
	var tp tape
	if tp.render(unicodeMode) != "" {
		t.Error("an empty tape must render nothing")
	}
	// Within one bucket a blip must survive a recovery, or the strip would
	// pretend the link was fine.
	tp.sample(StateConnected)
	tp.sample(StateOffline)
	tp.sample(StateConnected)
	tp.commit()
	if got := tp.render(unicodeMode); got != "▁" {
		t.Errorf("tape = %q, want the offline cell", got)
	}
	tp.sample(StateConnected)
	tp.commit()
	if got := tp.render(unicodeMode); got != "▁█" {
		t.Errorf("tape = %q, want offline then connected", got)
	}
}

func TestTapeCommitWithoutSampleIsNoop(t *testing.T) {
	var tp tape
	tp.commit()
	if tp.filled != 0 {
		t.Errorf("filled = %d, want 0", tp.filled)
	}
}

func TestTapeRingIsBounded(t *testing.T) {
	var tp tape
	for i := 0; i < tapeCells*3; i++ {
		tp.sample(StateConnected)
		tp.commit()
	}
	if got := visibleWidth(tp.render(unicodeMode)); got != tapeCells {
		t.Errorf("tape width = %d, want %d", got, tapeCells)
	}
}

func TestStatusRenderSkipsOnlyTheFieldsThatDoNotFit(t *testing.T) {
	now := time.Now()
	// The peer name is far too long for this width; the history strip after it
	// is three cells and must still make it in.
	st := Status{
		Started: now, State: StateConnected, Sessions: 1,
		Peer: "somebody@an-absurdly-long-hostname-that-will-not-fit · bash -c",
	}
	for i := 0; i < 3; i++ {
		st.tape.sample(StateConnected)
		st.tape.commit()
	}
	got := st.render(unicodeMode, now, 0, 30)
	if strings.Contains(got, "absurdly") {
		t.Errorf("bar %q kept a field that cannot fit", got)
	}
	if !strings.Contains(got, "███") {
		t.Errorf("bar %q dropped the history strip behind the oversized field", got)
	}
}
