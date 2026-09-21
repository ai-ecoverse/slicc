package computer

import (
	"strings"
	"testing"
)

func TestParseModeAcceptsTheDocumentedForms(t *testing.T) {
	cases := []struct {
		arg  string
		mode Mode
		ok   bool
	}{
		{"--computer", ModeBestEffort, true},
		{"--computer=require", ModeRequire, true},
		// `=auto` is the explicit spelling of the default, and a bare `=` is a
		// shell artifact of it rather than a typo worth refusing.
		{"--computer=auto", ModeBestEffort, true},
		{"--computer=", ModeBestEffort, true},
		// Rejected, NOT silently treated as best-effort: a plausible-looking
		// value asking for a hard requirement and quietly getting a soft one is
		// the failure this mode exists to prevent.
		{"--computer=always", ModeOff, false},
		{"--computer=true", ModeOff, false},
		// Not this flag at all — the caller keeps it as runner argv.
		{"--computers", ModeOff, false},
		{"--eval", ModeOff, false},
		{"", ModeOff, false},
	}
	for _, tc := range cases {
		mode, ok := ParseMode(tc.arg)
		if mode != tc.mode || ok != tc.ok {
			t.Errorf("ParseMode(%q) = (%v, %v), want (%v, %v)", tc.arg, mode, ok, tc.mode, tc.ok)
		}
	}
}

func TestNewPairIDIsUniqueAndPrefixed(t *testing.T) {
	seen := make(map[string]bool, 64)
	for i := 0; i < 64; i++ {
		id, err := NewPairID()
		if err != nil {
			t.Fatalf("NewPairID: %v", err)
		}
		if !strings.HasPrefix(id, "pair-") {
			t.Fatalf("NewPairID() = %q, want a pair- prefix", id)
		}
		// 128 bits of hex. Two concurrent `follow --computer` sessions that
		// minted the same token would name two exec peers in one group, and the
		// leader then folds NEITHER — both Macs silently lose native capture.
		if len(id) != len("pair-")+32 {
			t.Fatalf("NewPairID() = %q, want 32 hex chars", id)
		}
		if seen[id] {
			t.Fatalf("NewPairID() repeated %q", id)
		}
		seen[id] = true
	}
}

func TestGrantsSummaryNamesBothPermissions(t *testing.T) {
	partial := Grants{ScreenRecording: true}
	summary := partial.Summary()
	if !strings.Contains(summary, "Screen Recording: granted") {
		t.Errorf("summary %q should report Screen Recording granted", summary)
	}
	if !strings.Contains(summary, "Accessibility: not granted") {
		t.Errorf("summary %q should report Accessibility missing", summary)
	}
	if partial.Complete() {
		t.Error("a half-granted Mac is not complete")
	}
	if !(Grants{ScreenRecording: true, Accessibility: true}).Complete() {
		t.Error("both grants should read as complete")
	}
	if (Grants{}).Complete() {
		t.Error("an ungranted Mac is not complete")
	}
}
