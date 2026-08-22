package main

import "strings"

// joinURLState tracks the join URL across reconnect attempts. When the tray hub
// returns TRAY_SUPERSEDED, tray.Dial follows the chain and notifies
// onTrayJoinURLChanged; follow/watch persist the replacement so later reconnects
// do not walk the supersede chain from the original argv URL again.
type joinURLState struct {
	url      string
	advanced bool
}

func newJoinURLState(initial string) *joinURLState {
	return &joinURLState{url: initial}
}

func (s *joinURLState) current() string { return s.url }

func (s *joinURLState) beginAttempt() { s.advanced = false }

func (s *joinURLState) onTrayJoinURLChanged(next string) {
	next = strings.TrimSpace(next)
	if next != "" && next != s.url {
		s.url = next
		s.advanced = true
	}
}

// recordReconnectFailure returns the updated failure count and whether backoff
// should reset to the base interval. URL advancement during a dial is progress,
// not a dead end — don't burn the give-up budget.
func (s *joinURLState) recordReconnectFailure(failures int) (int, bool) {
	if s.advanced {
		return 0, true
	}
	return failures + 1, false
}
