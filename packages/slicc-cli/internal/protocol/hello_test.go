package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestHelloMotdRoundTrip covers the additive hello.motd field the `follow` CLI
// advertises so the leader can surface it to the agent (`ssh --list`).
func TestHelloMotdRoundTrip(t *testing.T) {
	h := Hello{
		Type:            TypeHello,
		ProtocolVersion: TraySyncProtocolVersion,
		Capabilities:    &Capabilities{Exec: true},
		Motd:            "slicc-cli exec target · a@b",
	}
	b, err := json.Marshal(h)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"motd":"slicc-cli exec target · a@b"`) {
		t.Fatalf("motd not encoded on the wire: %s", b)
	}
	var back Hello
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.Motd != h.Motd {
		t.Fatalf("motd round-trip: got %q, want %q", back.Motd, h.Motd)
	}

	// Additive + optional: an empty motd is omitted, so legacy leaders that
	// never read it see the exact same bytes as before.
	plain, _ := json.Marshal(Hello{Type: TypeHello, ProtocolVersion: 1})
	if strings.Contains(string(plain), "motd") {
		t.Fatalf("empty motd must be omitted: %s", plain)
	}
}
