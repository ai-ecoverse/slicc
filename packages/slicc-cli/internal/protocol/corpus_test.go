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
	// LeaderToFollowerExtra holds additional shapes of a type the keyed list
	// already covers once (e.g. the `rejected` user_message_ack).
	LeaderToFollowerExtra []corpusEntry `json:"leaderToFollowerExtra"`
	FollowerToLeader      []corpusEntry `json:"followerToLeader"`
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
	case TypeNewSession:
		return &NewSession{}
	case TypeRequestSnapshot:
		return &RequestSnapshot{}
	case TypeSnapshot:
		return &Snapshot{}
	case TypeModelsRequest:
		return &ModelsRequest{}
	case TypeModelsList:
		return &ModelsList{}
	case TypeModelSelect:
		return &ModelSelect{}
	case TypeModelState:
		return &ModelState{}
	case TypeUserMessageAck:
		return &UserMessageAck{}
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
	all := append(append(append([]corpusEntry{}, doc.LeaderToFollower...), doc.LeaderToFollowerExtra...), doc.FollowerToLeader...)

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

	// exec.* in both directions (8) + hello in both directions (2) + status (1)
	// + the session/model control set new-session and model use (7)
	// + user_message_ack accepted/rejected (2).
	if modeled < 20 {
		t.Fatalf("expected >=20 modeled corpus fixtures, found %d — did exec.*/hello/status/session/model/ack move?", modeled)
	}
}

// TestCorpusUserMessageAckStates pins the two ack fixtures `prompt` depends
// on: an accepted ack with no error, and a rejected one that carries it. The
// keyed list holds one fixture per type, so the rejected shape lives in
// leaderToFollowerExtra. ScoopJid is not required: a leader with no unit to
// deliver to rejects with an empty one, and `prompt` matches by messageId.
func TestCorpusUserMessageAckStates(t *testing.T) {
	doc := loadCorpus(t)
	states := map[string]UserMessageAck{}
	for _, e := range append(append([]corpusEntry{}, doc.LeaderToFollower...), doc.LeaderToFollowerExtra...) {
		if e.Type != TypeUserMessageAck {
			continue
		}
		var ack UserMessageAck
		if err := json.Unmarshal(e.Message, &ack); err != nil {
			t.Fatalf("decode %s: %v", e.Type, err)
		}
		if ack.MessageID == "" {
			t.Errorf("ack fixture missing messageId: %s", e.Message)
		}
		states[ack.State] = ack
	}
	if a, ok := states[AckAccepted]; !ok || a.Error != "" {
		t.Errorf("want an accepted ack fixture without error, got %#v (present=%v)", a, ok)
	}
	if r, ok := states[AckRejected]; !ok || r.Error == "" {
		t.Errorf("want a rejected ack fixture with error, got %#v (present=%v)", r, ok)
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
