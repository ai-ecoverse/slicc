package main

import "testing"

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

func TestJoinURLStateRecordReconnectFailure(t *testing.T) {
	s := newJoinURLState("https://hub.example/join/a")
	s.beginAttempt()
	failures, reset := s.recordReconnectFailure(3)
	if failures != 4 || reset {
		t.Fatalf("stale URL: failures=%d reset=%v, want 4 false", failures, reset)
	}

	s.onTrayJoinURLChanged("https://hub.example/join/b")
	failures, reset = s.recordReconnectFailure(3)
	if failures != 0 || !reset {
		t.Fatalf("advanced URL: failures=%d reset=%v, want 0 true", failures, reset)
	}
}
