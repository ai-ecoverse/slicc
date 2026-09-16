package main

import (
	"strings"

	"github.com/ai-ecoverse/slicc-cli/internal/tray"
)

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

		s.url = next
		s.advanced = false
		return
	}
	s.seen[next] = struct{}{}
	s.url = next
	s.advanced = true
}

func (s *joinURLState) recordReconnectFailure(failures int, err error) (int, bool) {
	if s.advanced &&
		!tray.IsSupersedeChainExhausted(err) &&
		!tray.IsSupersedeMissingJoin(err) {
		return 0, true
	}
	return failures + 1, false
}
