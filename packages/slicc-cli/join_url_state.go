package main

import (
	"strings"

	"github.com/ai-ecoverse/slicc-cli/internal/tray"
)

// joinURLState tracks the join URL across reconnect attempts. When the tray hub
// returns TRAY_SUPERSEDED, tray.Dial follows the chain and notifies
// onTrayJoinURLChanged; follow/watch persist the replacement so later reconnects
// do not walk the supersede chain from the original argv URL again.
type joinURLState struct {
	url      string
	advanced bool
	seen     map[string]struct{}
}

func newJoinURLState(initial string) *joinURLState {
	seen := map[string]struct{}{initial: {}}
	return &joinURLState{url: initial, seen: seen}
}

func (s *joinURLState) current() string { return s.url }

func (s *joinURLState) beginAttempt() { s.advanced = false }

func (s *joinURLState) onTrayJoinURLChanged(next string) {
	next = strings.TrimSpace(next)
	if next == "" || next == s.url {
		return
	}
	if _, revisit := s.seen[next]; revisit {
		// A→B→A cycles advance the current URL but are not progress toward a
		// fresh tray — don't reset the give-up budget on them.
		s.url = next
		s.advanced = false
		return
	}
	s.seen[next] = struct{}{}
	s.url = next
	s.advanced = true
}

// recordReconnectFailure returns the updated failure count and whether backoff
// should reset to the base interval. Only a forward supersede hop that did not
// end in a terminal attach error counts as progress.
func (s *joinURLState) recordReconnectFailure(failures int, err error) (int, bool) {
	if s.advanced &&
		!tray.IsSupersedeChainExhausted(err) &&
		!tray.IsSupersedeMissingJoin(err) {
		return 0, true
	}
	return failures + 1, false
}
