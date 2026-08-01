package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestHelloCapabilitiesRoundTripExplicitFalse pins the distinction `omitempty`
// used to erase: a peer that advertises `capabilities` is making a statement,
// and "cannot run shell commands" has to survive the wire. The iOS follower
// sends exactly this.
func TestHelloCapabilitiesRoundTripExplicitFalse(t *testing.T) {
	h := Hello{
		Type:            "hello",
		ProtocolVersion: 1,
		Runtime:         "slicc-ios",
		Capabilities:    &Capabilities{Exec: false},
	}
	b, err := json.Marshal(h)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"capabilities":{"exec":false}`) {
		t.Fatalf("explicit exec:false was dropped on the wire: %s", b)
	}

	var back Hello
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.Capabilities == nil || back.Capabilities.Exec {
		t.Fatalf("capabilities round-trip: got %+v, want exec=false", back.Capabilities)
	}
}

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
