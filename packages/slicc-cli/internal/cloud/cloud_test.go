package cloud

import (
	"strings"
	"testing"
	"time"
)

func mustTime(t *testing.T, rfc string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, rfc)
	if err != nil {
		t.Fatalf("parsing %q: %v", rfc, err)
	}
	return parsed
}

func TestParseSessions(t *testing.T) {
	data := []byte(`[{"id":"abc123","label":"Chrome","deviceId":"d1","deviceName":"MacA","createdAt":"2026-07-30T10:00:00Z","lastSeenAt":"2026-07-30T11:00:00Z","joinUrl":"https://slicc.test/join/x.secret"}]`)
	sessions, err := ParseSessions(data)
	if err != nil {
		t.Fatalf("ParseSessions: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("want 1 session, got %d", len(sessions))
	}
	s := sessions[0]
	if s.ID != "abc123" || s.Label != "Chrome" || s.DeviceName != "MacA" {
		t.Errorf("unexpected metadata: %+v", s)
	}
	if s.JoinURL != "https://slicc.test/join/x.secret" {
		t.Errorf("join URL not parsed: %q", s.JoinURL)
	}
	if !s.LastSeenAt.Equal(mustTime(t, "2026-07-30T11:00:00Z")) {
		t.Errorf("lastSeenAt not parsed as RFC3339: %v", s.LastSeenAt)
	}
}

func TestParseSessionsEmptyAndInvalid(t *testing.T) {
	empty, err := ParseSessions([]byte(`[]`))
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty array: got %v, %v", empty, err)
	}
	if _, err := ParseSessions([]byte(`not json`)); err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestParseSelector(t *testing.T) {
	tests := []struct {
		name     string
		args     []string
		wantSel  Selector
		wantRest []string
	}{
		{"none", []string{"bash", "-c"}, Selector{}, []string{"bash", "-c"}},
		{"index space", []string{"--index", "2", "bash"}, Selector{Index: 2}, []string{"bash"}},
		{"index equals", []string{"--index=3"}, Selector{Index: 3}, nil},
		{"session space", []string{"--session", "abc", "sh"}, Selector{IDPrefix: "abc"}, []string{"sh"}},
		{"session equals", []string{"--session=def"}, Selector{IDPrefix: "def"}, nil},
		{"terminator", []string{"--", "--index", "9"}, Selector{}, []string{"--index", "9"}},
		{"stops at non-flag", []string{"bash", "--index", "1"}, Selector{}, []string{"bash", "--index", "1"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sel, rest, err := ParseSelector(tt.args)
			if err != nil {
				t.Fatalf("ParseSelector: %v", err)
			}
			if sel != tt.wantSel {
				t.Errorf("selector: got %+v want %+v", sel, tt.wantSel)
			}
			if strings.Join(rest, ",") != strings.Join(tt.wantRest, ",") {
				t.Errorf("rest: got %v want %v", rest, tt.wantRest)
			}
		})
	}
}

func TestParseSelectorErrors(t *testing.T) {
	if _, _, err := ParseSelector([]string{"--index", "abc"}); err == nil {
		t.Error("expected error for non-numeric --index")
	}
	if _, _, err := ParseSelector([]string{"--index=xyz"}); err == nil {
		t.Error("expected error for non-numeric --index=")
	}
}

func sampleSessions(t *testing.T) []Session {
	t.Helper()
	return []Session{
		{ID: "old00000", Label: "Old", LastSeenAt: mustTime(t, "2026-07-30T09:00:00Z"), JoinURL: "u-old"},
		{ID: "new11111", Label: "New", LastSeenAt: mustTime(t, "2026-07-30T12:00:00Z"), JoinURL: "u-new"},
		{ID: "mid22222", Label: "Mid", LastSeenAt: mustTime(t, "2026-07-30T10:30:00Z"), JoinURL: "u-mid"},
	}
}

func TestSelectNewestFirst(t *testing.T) {
	got, err := Select(sampleSessions(t), Selector{Index: 0})
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if got.ID != "new11111" {
		t.Errorf("index 0 should be newest, got %q", got.ID)
	}
}

func TestSelectByIndex(t *testing.T) {
	got, err := Select(sampleSessions(t), Selector{Index: 2})
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if got.ID != "old00000" {
		t.Errorf("index 2 should be oldest, got %q", got.ID)
	}
}

func TestSelectIndexOutOfRange(t *testing.T) {
	if _, err := Select(sampleSessions(t), Selector{Index: 9}); err == nil {
		t.Error("expected out-of-range error")
	}
	if _, err := Select(sampleSessions(t), Selector{Index: -1}); err == nil {
		t.Error("expected out-of-range error for negative index")
	}
}

func TestSelectByIDPrefix(t *testing.T) {
	got, err := Select(sampleSessions(t), Selector{IDPrefix: "mid"})
	if err != nil {
		t.Fatalf("Select: %v", err)
	}
	if got.ID != "mid22222" {
		t.Errorf("prefix mid should select mid, got %q", got.ID)
	}
}

func TestSelectIDPrefixNoMatchAndAmbiguous(t *testing.T) {
	if _, err := Select(sampleSessions(t), Selector{IDPrefix: "zzz"}); err == nil {
		t.Error("expected no-match error")
	}
	dup := []Session{
		{ID: "dupe1", LastSeenAt: mustTime(t, "2026-07-30T09:00:00Z")},
		{ID: "dupe2", LastSeenAt: mustTime(t, "2026-07-30T10:00:00Z")},
	}
	if _, err := Select(dup, Selector{IDPrefix: "dup"}); err == nil {
		t.Error("expected ambiguous-prefix error")
	}
}

func TestSelectEmpty(t *testing.T) {
	if _, err := Select(nil, Selector{}); err == nil {
		t.Error("expected error for empty session list")
	}
}

func TestFormatTable(t *testing.T) {
	now := mustTime(t, "2026-07-30T12:05:00Z")
	out := FormatTable(sampleSessions(t), now)
	if !strings.Contains(out, "LABEL") || !strings.Contains(out, "AGE") {
		t.Errorf("missing header: %q", out)
	}
	// Newest first, and no join URL ever leaks into the table.
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if !strings.Contains(lines[1], "New") {
		t.Errorf("first row should be newest: %q", lines[1])
	}
	if strings.Contains(out, "u-new") || strings.Contains(out, "u-old") {
		t.Errorf("table must not contain join URLs: %q", out)
	}
	if strings.Contains(out, "just now") {
		// 5m after last seen for the newest → "5m ago"
		t.Errorf("expected minute-granular age, got %q", out)
	}
}

func TestFormatTableEmpty(t *testing.T) {
	out := FormatTable(nil, time.Now())
	if !strings.Contains(out, "No active tray sessions") {
		t.Errorf("unexpected empty output: %q", out)
	}
}

func TestFormatAge(t *testing.T) {
	cases := map[time.Duration]string{
		30 * time.Second: "just now",
		5 * time.Minute:  "5m ago",
		3 * time.Hour:    "3h ago",
		50 * time.Hour:   "2d ago",
	}
	for d, want := range cases {
		if got := formatAge(d); got != want {
			t.Errorf("formatAge(%v) = %q, want %q", d, got, want)
		}
	}
}

func TestTruncateAndShortID(t *testing.T) {
	if shortID("0123456789abcdef") != "0123456789ab" {
		t.Errorf("shortID truncation wrong: %q", shortID("0123456789abcdef"))
	}
	if shortID("short") != "short" {
		t.Errorf("shortID should pass through short ids")
	}
	if truncate("hello", 10) != "hello" {
		t.Error("truncate should pass short strings")
	}
	if got := truncate("abcdefghij", 5); got != "abcd…" {
		t.Errorf("truncate = %q", got)
	}
}
