package main

import (
	"testing"

	"github.com/ai-ecoverse/slicc-cli/internal/tray"
)

func TestJoinURLStatePersistsReplacement(t *testing.T) {
	s := newJoinURLState("https://hub.example/join/a")
	s.onTrayJoinURLChanged("https://hub.example/join/b")
	if got := s.current(); got != "https://hub.example/join/b" {
		t.Fatalf("current = %q, want b", got)
	}
	if !s.advanced {
		t.Fatal("expected advanced after replacement")
	}
}

func TestJoinURLStateIgnoresBlankAndDuplicate(t *testing.T) {
	s := newJoinURLState("https://hub.example/join/a")
	s.onTrayJoinURLChanged("   ")
	s.onTrayJoinURLChanged("https://hub.example/join/a")
	if s.advanced {
		t.Fatal("blank/duplicate should not advance")
	}
}

func TestJoinURLStateRevisitIsNotProgress(t *testing.T) {
	s := newJoinURLState("https://hub.example/join/a")
	s.onTrayJoinURLChanged("https://hub.example/join/b")
	s.onTrayJoinURLChanged("https://hub.example/join/a")
	if got := s.current(); got != "https://hub.example/join/a" {
		t.Fatalf("current = %q, want a", got)
	}
	if s.advanced {
		t.Fatal("revisiting a URL should not count as progress")
	}
}

func TestJoinURLStateRecordReconnectFailure(t *testing.T) {
	s := newJoinURLState("https://hub.example/join/a")
	s.beginAttempt()
	failures, reset := s.recordReconnectFailure(3, nil)
	if failures != 4 || reset {
		t.Fatalf("stale URL: failures=%d reset=%v, want 4 false", failures, reset)
	}

	s.onTrayJoinURLChanged("https://hub.example/join/b")
	failures, reset = s.recordReconnectFailure(3, nil)
	if failures != 0 || !reset {
		t.Fatalf("forward hop: failures=%d reset=%v, want 0 true", failures, reset)
	}

	s.beginAttempt()
	s.onTrayJoinURLChanged("https://hub.example/join/c")
	chainErr := &tray.AttachError{Code: tray.AttachCodeSupersededChainExhausted}
	failures, reset = s.recordReconnectFailure(5, chainErr)
	if failures != 6 || reset {
		t.Fatalf("chain exhausted: failures=%d reset=%v, want 6 false", failures, reset)
	}
}
