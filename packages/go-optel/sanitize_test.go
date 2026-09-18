package optel

import (
	"errors"
	"strings"
	"testing"
)

func TestSanitizeRedactsJoinURLToken(t *testing.T) {
	
	
	
	msg := `Get "https://sliccy.ai/join/super-secret-token-abc123": dial tcp: lookup sliccy.ai: no such host`
	got := Sanitize(msg)
	if strings.Contains(got, "super-secret-token-abc123") {
		t.Fatalf("Sanitize leaked the join token: %q", got)
	}
	if strings.Contains(got, "/join/") {
		t.Fatalf("Sanitize leaked the URL path: %q", got)
	}
	if !strings.Contains(got, "sliccy.ai") {
		t.Fatalf("expected the host to survive redaction, got %q", got)
	}
}

func TestSanitizeRedactsMultipleURLs(t *testing.T) {
	msg := "primary https://a.example.com/join/tok1 failed, retrying https://b.example.com/join/tok2"
	got := Sanitize(msg)
	if strings.Contains(got, "tok1") || strings.Contains(got, "tok2") {
		t.Fatalf("Sanitize leaked a token from a multi-URL message: %q", got)
	}
}

func TestSanitizeCollapsesPosixPath(t *testing.T) {
	msg := "open /Users/lars/.slicc/logs/slicc-2026-07-28.log: permission denied"
	got := Sanitize(msg)
	if strings.Contains(got, "lars") {
		t.Fatalf("Sanitize leaked the username segment: %q", got)
	}
	if !strings.Contains(got, "/Users/...") {
		t.Fatalf("expected the first path segment to survive, got %q", got)
	}
}

func TestSanitizeCollapsesWindowsPath(t *testing.T) {
	msg := `open C:\Users\lars\AppData\slicc\state.json: access is denied`
	got := Sanitize(msg)
	if strings.Contains(got, "lars") {
		t.Fatalf("Sanitize leaked the username segment: %q", got)
	}
	if !strings.Contains(got, `C:\...`) {
		t.Fatalf("expected the drive letter to survive, got %q", got)
	}
}

func TestSanitizeTruncates(t *testing.T) {
	got := Sanitize(strings.Repeat("a", 500))
	if len([]rune(got)) != MaxMessageLength {
		t.Fatalf("expected truncation to %d runes, got %d", MaxMessageLength, len([]rune(got)))
	}
}

func TestSanitizeNeverGrowsAURLPastTruncationBoundary(t *testing.T) {
	
	
	
	prefix := strings.Repeat("x", 190)
	msg := prefix + " https://sliccy.ai/join/leaked-token-should-not-appear"
	got := Sanitize(msg)
	if strings.Contains(got, "leaked-token-should-not-appear") {
		t.Fatalf("Sanitize leaked a token that should have been redacted before truncation: %q", got)
	}
}

func TestSanitizeLeavesOrdinaryMessagesAlone(t *testing.T) {
	msg := "connection refused"
	if got := Sanitize(msg); got != msg {
		t.Fatalf("expected %q unchanged, got %q", msg, got)
	}
}

func TestSanitizeHandlesRealNetURLError(t *testing.T) {
	
	err := errors.New(`Post "https://sliccy.ai/join/abcdef0123456789": context deadline exceeded`)
	got := Sanitize(err.Error())
	if strings.Contains(got, "abcdef0123456789") {
		t.Fatalf("Sanitize leaked a token from a net/url-shaped error: %q", got)
	}
}
