package protocol

import (
	"encoding/json"
	"strings"
	"testing"
)





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

	
	
	plain, _ := json.Marshal(Hello{Type: TypeHello, ProtocolVersion: 1})
	if strings.Contains(string(plain), "motd") {
		t.Fatalf("empty motd must be omitted: %s", plain)
	}
}




func TestHelloPairIDRoundTrip(t *testing.T) {
	h := Hello{
		Type:            TypeHello,
		ProtocolVersion: TraySyncProtocolVersion,
		Capabilities:    &Capabilities{Exec: true},
		PairID:          "pair-0123456789abcdef",
	}
	b, err := json.Marshal(h)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(b), `"pairId":"pair-0123456789abcdef"`) {
		t.Fatalf("pairId was dropped on the wire: %s", b)
	}

	var back Hello
	if err := json.Unmarshal(b, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.PairID != h.PairID {
		t.Fatalf("pairId round-trip: got %q, want %q", back.PairID, h.PairID)
	}

	
	
	bare, err := json.Marshal(Hello{Type: TypeHello, ProtocolVersion: TraySyncProtocolVersion})
	if err != nil {
		t.Fatalf("marshal bare: %v", err)
	}
	if strings.Contains(string(bare), "pairId") {
		t.Fatalf("an unset pairId must not be sent: %s", bare)
	}
}
