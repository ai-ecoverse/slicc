package tray

import (
	"testing"

	"github.com/ai-ecoverse/slicc-cli/internal/signaling"
)

func cand(s string) signaling.IceCandidate {
	return signaling.IceCandidate{Candidate: s}
}

func TestTrickleQueueHoldsCandidatesUntilRelease(t *testing.T) {
	var q trickleQueue
	var got []string
	send := func(c signaling.IceCandidate) { got = append(got, c.Candidate) }

	q.pushOrSend(cand("host"), send)
	q.pushOrSend(cand("srflx"), send)
	if len(got) != 0 {
		t.Fatalf("sent before release: %v", got)
	}

	q.release(send)
	q.pushOrSend(cand("relay"), send)

	want := []string{"host", "srflx", "relay"}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestTrickleQueueResetDropsWhatWasHeld(t *testing.T) {
	var q trickleQueue
	var got []string
	send := func(c signaling.IceCandidate) { got = append(got, c.Candidate) }

	q.pushOrSend(cand("stale"), send)
	q.reset()
	q.release(send)
	if len(got) != 0 {
		t.Fatalf("reset candidate was sent: %v", got)
	}
}
