package optel

import "testing"

func TestGenerateSessionIDLength(t *testing.T) {
	id := GenerateSessionID()
	if len([]rune(id)) != 9 {
		t.Fatalf("GenerateSessionID() = %q, want 9 runes, got %d", id, len([]rune(id)))
	}
}

func TestGenerateSessionIDVaries(t *testing.T) {
	a := GenerateSessionID()
	b := GenerateSessionID()
	if a == b {
		t.Fatalf("two consecutive session ids collided: %q", a)
	}
}
