package protocol

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// The golden corpus is the cross-language wire fixture set generated from
// packages/webapp/src/scoops/tray-sync-protocol-corpus.ts. This test decodes the
// message types the CLI models (exec.* + hello + status) into the Go structs and asserts a
// lossless round-trip, so a TS wire change that would break the CLI fails here.

type corpusEntry struct {
	Type    string          `json:"type"`
	IOS     string          `json:"ios"`
	Message json.RawMessage `json:"message"`
}

type corpusDoc struct {
	TraySyncProtocolVersion int           `json:"traySyncProtocolVersion"`
	LeaderToFollower        []corpusEntry `json:"leaderToFollower"`
	FollowerToLeader        []corpusEntry `json:"followerToLeader"`
}

func loadCorpus(t *testing.T) corpusDoc {
	t.Helper()
	path := filepath.Join("..", "..", "..", "ios-app", "SliccFollower",
		"Tests", "SliccFollowerTests", "Fixtures", "tray-sync-corpus.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read corpus: %v", err)
	}
	var doc corpusDoc
	if err := json.Unmarshal(data, &doc); err != nil {
		t.Fatalf("parse corpus: %v", err)
	}
	return doc
}

// target returns a pointer to the Go struct for a modeled type, or nil.
func target(typ string) any {
	switch typ {
	case TypeHello:
		return &Hello{}
	case TypeExecRequest:
		return &ExecRequest{}
	case TypeExecChunk:
		return &ExecChunk{}
	case TypeExecResponse:
		return &ExecResponse{}
	case TypeExecSignal:
		return &ExecSignal{}
	case TypeStatus:
		return &Status{}
	default:
		return nil
	}
}

func TestCorpusVersionMatches(t *testing.T) {
	doc := loadCorpus(t)
	if doc.TraySyncProtocolVersion != TraySyncProtocolVersion {
		t.Fatalf("corpus protocol version %d != CLI %d", doc.TraySyncProtocolVersion, TraySyncProtocolVersion)
	}
}

func TestCorpusExecAndHelloRoundTrip(t *testing.T) {
	doc := loadCorpus(t)
	all := append(append([]corpusEntry{}, doc.LeaderToFollower...), doc.FollowerToLeader...)

	modeled := 0
	for _, e := range all {
		dst := target(e.Type)
		if dst == nil {
			continue // the CLI ignores this message type
		}
		modeled++
		if err := json.Unmarshal(e.Message, dst); err != nil {
			t.Errorf("%s: decode into Go struct: %v", e.Type, err)
			continue
		}
		reencoded, err := json.Marshal(dst)
		if err != nil {
			t.Errorf("%s: re-encode: %v", e.Type, err)
			continue
		}
		var original, roundtripped map[string]any
		_ = json.Unmarshal(e.Message, &original)
		_ = json.Unmarshal(reencoded, &roundtripped)
		if !reflect.DeepEqual(original, roundtripped) {
			t.Errorf("%s: round-trip mismatch\n original:   %s\n re-encoded: %s", e.Type, e.Message, reencoded)
		}
	}

	// exec.* in both directions (8) + hello in both directions (2) + status (1).
	if modeled < 11 {
		t.Fatalf("expected >=11 modeled corpus fixtures, found %d — did exec.*/hello/status move?", modeled)
	}
}

func TestLegacyStatusWithoutScoopJidDecodes(t *testing.T) {
	var status Status
	if err := json.Unmarshal([]byte(`{"type":"status","scoopStatus":"ready"}`), &status); err != nil {
		t.Fatalf("decode legacy status: %v", err)
	}
	if status.Type != TypeStatus || status.ScoopStatus != "ready" || status.ScoopJid != "" {
		t.Fatalf("unexpected legacy status: %#v", status)
	}
}
