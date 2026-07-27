package tray

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
)

// Transport-level chunk framing (#1700). A message over the SCTP per-message
// limit was previously handed straight to SendText, which fails and drops it.

func TestFrameChunksStaysWithinTransportLimit(t *testing.T) {
	// CJK: 3 UTF-8 bytes per rune. Sizing that counts runes rather than bytes
	// under-counts these 3x and produces frames the transport rejects.
	payload, err := json.Marshal(map[string]string{"text": strings.Repeat("漢", 120_000)})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	frames := frameChunks(string(payload), "fixed")
	if len(frames) < 2 {
		t.Fatalf("expected multiple frames, got %d", len(frames))
	}
	for _, frame := range frames {
		encoded, err := json.Marshal(frame)
		if err != nil {
			t.Fatalf("marshal frame: %v", err)
		}
		if len(encoded) > maxMessageBytes {
			t.Errorf("frame %d is %d bytes, over the %d limit",
				frame.ChunkIndex, len(encoded), maxMessageBytes)
		}
	}
}

func TestFrameChunksRoundTrips(t *testing.T) {
	payload := `{"mixed":"a\"\\b` + strings.Repeat("漢", 50_000) + `🍦"}`

	var rebuilt strings.Builder
	for _, frame := range frameChunks(payload, "fixed") {
		rebuilt.WriteString(frame.ChunkData)
	}

	if rebuilt.String() != payload {
		t.Error("reassembled payload differs from the original")
	}
}

func TestFrameChunksSplitsOnRuneBoundaries(t *testing.T) {
	// A frame cut mid-rune corrupts both halves; Go strings carry raw UTF-8
	// with no surrogate-escape safety net.
	payload := strings.Repeat("漢", 100_000)

	for _, frame := range frameChunks(payload, "fixed") {
		if !utf8.ValidString(frame.ChunkData) {
			t.Fatalf("frame %d is not valid UTF-8", frame.ChunkIndex)
		}
	}
}

func TestFrameChunksNumbersFramesConsistently(t *testing.T) {
	frames := frameChunks(strings.Repeat("y", 200_000), "shared-id")

	for i, frame := range frames {
		if frame.Type != protocol.TypeChunk {
			t.Errorf("frame %d has type %q", i, frame.Type)
		}
		if frame.ChunkID != "shared-id" {
			t.Errorf("frame %d has chunkId %q", i, frame.ChunkID)
		}
		if frame.ChunkIndex != i {
			t.Errorf("frame at position %d reports index %d", i, frame.ChunkIndex)
		}
		if frame.TotalChunks != len(frames) {
			t.Errorf("frame %d reports total %d, want %d", i, frame.TotalChunks, len(frames))
		}
	}
}

func TestFrameChunksEmptyPayloadYieldsOneFrame(t *testing.T) {
	if got := len(frameChunks("", "e")); got != 1 {
		t.Errorf("got %d frames for an empty payload, want 1", got)
	}
}

// newConnForDispatch builds a Conn wired only for inbound dispatch.
func newConnForDispatch(onMessage func(string, []byte)) *Conn {
	return &Conn{
		opts: Options{OnMessage: onMessage},
		done: make(chan struct{}),
	}
}

func TestDispatchReassemblesChunkedMessage(t *testing.T) {
	var got []byte
	var gotType string
	c := newConnForDispatch(func(msgType string, raw []byte) {
		gotType, got = msgType, raw
	})

	original, err := json.Marshal(protocol.UserMessageEcho{
		Type: protocol.TypeUserMessageEcho,
		Text: strings.Repeat("x", 200_000),
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	for _, frame := range frameChunks(string(original), "m1") {
		encoded, err := json.Marshal(frame)
		if err != nil {
			t.Fatalf("marshal frame: %v", err)
		}
		c.dispatch(encoded)
	}

	// The handler sees the reconstructed message, never the framing.
	if gotType != protocol.TypeUserMessageEcho {
		t.Errorf("got type %q, want %q", gotType, protocol.TypeUserMessageEcho)
	}
	if string(got) != string(original) {
		t.Error("reassembled message differs from the original")
	}
}

func TestDispatchReassemblesOutOfOrderFrames(t *testing.T) {
	var got []byte
	c := newConnForDispatch(func(_ string, raw []byte) { got = raw })

	original := `{"type":"user_message_echo","text":"` + strings.Repeat("x", 200_000) + `"}`
	frames := frameChunks(original, "ooo")
	for i := len(frames) - 1; i >= 0; i-- {
		encoded, _ := json.Marshal(frames[i])
		c.dispatch(encoded)
	}

	if string(got) != original {
		t.Error("out-of-order frames did not reassemble correctly")
	}
}

func TestDispatchIgnoresDuplicateFrames(t *testing.T) {
	calls := 0
	c := newConnForDispatch(func(_ string, _ []byte) { calls++ })

	original := `{"type":"user_message_echo","text":"` + strings.Repeat("x", 200_000) + `"}`
	for _, frame := range frameChunks(original, "dup") {
		encoded, _ := json.Marshal(frame)
		c.dispatch(encoded)
		c.dispatch(encoded)
	}

	if calls != 1 {
		t.Errorf("handler ran %d times, want 1", calls)
	}
}

func TestDispatchWaitsForEveryFrame(t *testing.T) {
	calls := 0
	c := newConnForDispatch(func(_ string, _ []byte) { calls++ })

	original := `{"type":"user_message_echo","text":"` + strings.Repeat("x", 200_000) + `"}`
	frames := frameChunks(original, "partial")
	for _, frame := range frames[:len(frames)-1] {
		encoded, _ := json.Marshal(frame)
		c.dispatch(encoded)
	}

	if calls != 0 {
		t.Errorf("handler ran %d times before the last frame arrived", calls)
	}
}

func TestDispatchKeepsConcurrentReassembliesSeparate(t *testing.T) {
	var got []string
	c := newConnForDispatch(func(_ string, raw []byte) { got = append(got, string(raw)) })

	first := `{"type":"user_message_echo","text":"` + strings.Repeat("a", 200_000) + `"}`
	second := `{"type":"user_message_echo","text":"` + strings.Repeat("b", 180_000) + `"}`
	a := frameChunks(first, "A")
	b := frameChunks(second, "B")

	for i := 0; i < len(a) || i < len(b); i++ {
		if i < len(a) {
			encoded, _ := json.Marshal(a[i])
			c.dispatch(encoded)
		}
		if i < len(b) {
			encoded, _ := json.Marshal(b[i])
			c.dispatch(encoded)
		}
	}

	if len(got) != 2 {
		t.Fatalf("got %d messages, want 2", len(got))
	}
	if got[0] != first && got[1] != first {
		t.Error("first message was not reassembled")
	}
	if got[0] != second && got[1] != second {
		t.Error("second message was not reassembled")
	}
}

func TestDispatchDropsMalformedFrame(t *testing.T) {
	calls := 0
	c := newConnForDispatch(func(_ string, _ []byte) { calls++ })

	// `__chunk` is reserved transport vocabulary: a frame with impossible
	// indices is dropped, never passed along as a message.
	bad, _ := json.Marshal(protocol.ChunkFrame{
		Type:        protocol.TypeChunk,
		ChunkID:     "bad",
		ChunkIndex:  5,
		TotalChunks: 2,
		ChunkData:   "x",
	})
	c.dispatch(bad)

	if calls != 0 {
		t.Errorf("handler ran %d times for a malformed frame", calls)
	}
}

func TestDispatchEvictsOldestIncompleteReassembly(t *testing.T) {
	calls := 0
	c := newConnForDispatch(func(_ string, _ []byte) { calls++ })

	original := `{"type":"user_message_echo","text":"` + strings.Repeat("x", 200_000) + `"}`
	started := make([][]protocol.ChunkFrame, 0, maxPendingReassemblies+2)
	for i := 0; i < maxPendingReassemblies+2; i++ {
		frames := frameChunks(original, string(rune('a'+i)))
		started = append(started, frames)
		encoded, _ := json.Marshal(frames[0])
		c.dispatch(encoded)
	}

	// The oldest was evicted, so completing it emits nothing.
	for _, frame := range started[0][1:] {
		encoded, _ := json.Marshal(frame)
		c.dispatch(encoded)
	}

	if calls != 0 {
		t.Errorf("handler ran %d times for an evicted reassembly", calls)
	}
}

func TestDispatchPassesSmallMessagesThrough(t *testing.T) {
	var gotType string
	c := newConnForDispatch(func(msgType string, _ []byte) { gotType = msgType })

	c.dispatch([]byte(`{"type":"user_message_echo","text":"hi"}`))

	if gotType != protocol.TypeUserMessageEcho {
		t.Errorf("got type %q, want %q", gotType, protocol.TypeUserMessageEcho)
	}
}
