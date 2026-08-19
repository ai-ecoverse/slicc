package tray

import (
	"encoding/json"
	"fmt"
	"log/slog"
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

func TestDispatchCountsEmptyChunkDataAsArrived(t *testing.T) {
	calls := 0
	c := newConnForDispatch(func(_ string, _ []byte) { calls++ })

	// A duplicated EMPTY frame must not advance the arrival count. Using the
	// empty string as a "not received" sentinel would let this 3-frame message
	// complete after only two distinct frames, emitting a message with a hole in
	// it. The TS and Swift receivers distinguish empty from missing; so does this
	// one.
	empty := protocol.ChunkFrame{
		Type: protocol.TypeChunk, ChunkID: "e", ChunkIndex: 0, TotalChunks: 3, ChunkData: "",
	}
	second := protocol.ChunkFrame{
		Type: protocol.TypeChunk, ChunkID: "e", ChunkIndex: 1, TotalChunks: 3,
		ChunkData: `{"type":"user_message_echo","text":"hi"}`,
	}
	for _, frame := range []protocol.ChunkFrame{empty, empty, second} {
		encoded, _ := json.Marshal(frame)
		c.dispatch(encoded)
	}

	if calls != 0 {
		t.Errorf("handler ran %d times before the third frame arrived", calls)
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

func TestDispatchSurvivesInconsistentTotalChunks(t *testing.T) {
	calls := 0
	c := newConnForDispatch(func(_ string, _ []byte) { calls++ })

	// A later frame re-declaring a larger TotalChunks used to index past the
	// buffer sized by the first frame, panicking the data-channel read goroutine
	// — a remote crash from two frames.
	first, _ := json.Marshal(protocol.ChunkFrame{
		Type: protocol.TypeChunk, ChunkID: "x", ChunkIndex: 0, TotalChunks: 2, ChunkData: "a",
	})
	second, _ := json.Marshal(protocol.ChunkFrame{
		Type: protocol.TypeChunk, ChunkID: "x", ChunkIndex: 99, TotalChunks: 100, ChunkData: "b",
	})
	c.dispatch(first)
	c.dispatch(second)

	if calls != 0 {
		t.Errorf("handler ran %d times for an inconsistent frame", calls)
	}
}

func TestDispatchRejectsExcessiveChunkCount(t *testing.T) {
	calls := 0
	c := newConnForDispatch(func(_ string, _ []byte) { calls++ })

	// Allocating per-frame bookkeeping for a claimed billion frames would
	// exhaust the process before any payload arrived.
	encoded, _ := json.Marshal(protocol.ChunkFrame{
		Type: protocol.TypeChunk, ChunkID: "huge", ChunkIndex: 0,
		TotalChunks: 1_000_000_000, ChunkData: "a",
	})
	c.dispatch(encoded)

	if calls != 0 {
		t.Errorf("handler ran %d times for an excessive frame count", calls)
	}
	c.reassemblyMu.Lock()
	pending := len(c.reassembly)
	c.reassemblyMu.Unlock()
	if pending != 0 {
		t.Errorf("buffered %d reassemblies for an excessive frame count", pending)
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

// The empty string is a syntactically valid chunkId, so it must be evictable
// like any other id — a sentinel-based selection would skip it (or let a later
// map entry steal the selection) and the pending-entry bound would not hold.
func TestDispatchEvictsOldestEvenWithEmptyChunkID(t *testing.T) {
	calls := 0
	c := newConnForDispatch(func(_ string, _ []byte) { calls++ })

	original := `{"type":"user_message_echo","text":"` + strings.Repeat("x", 200_000) + `"}`
	oldest := frameChunks(original, "")
	encoded, _ := json.Marshal(oldest[0])
	c.dispatch(encoded)
	for i := 0; i < maxPendingReassemblies+1; i++ {
		frames := frameChunks(original, string(rune('a'+i)))
		encoded, _ := json.Marshal(frames[0])
		c.dispatch(encoded)
	}

	// The empty-id reassembly was the oldest, so completing it emits nothing.
	for _, frame := range oldest[1:] {
		encoded, _ := json.Marshal(frame)
		c.dispatch(encoded)
	}

	if calls != 0 {
		t.Errorf("handler ran %d times for an evicted empty-id reassembly", calls)
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

func TestDispatchReportsActivity(t *testing.T) {
	beats := 0
	c := &Conn{
		opts: Options{OnActivity: func() { beats++ }},
		done: make(chan struct{}),
	}
	// Every inbound frame counts as proof of life, keepalives included — the
	// leader answers pings rather than sending them, so a follower that only
	// watched keepalives would never see one. Unparseable frames count too:
	// something is still arriving.
	c.dispatch([]byte(`{"type":"ping"}`))
	c.dispatch([]byte(`{"type":"pong"}`))
	c.dispatch([]byte(`{"type":"status","scoopStatus":"ready"}`))
	c.dispatch([]byte(`not json`))
	if beats != 4 {
		t.Errorf("counted %d frames, want 4", beats)
	}
}

func TestDispatchWithoutActivityHookIsFine(_ *testing.T) {
	c := newConnForDispatch(nil)
	c.dispatch([]byte(`{"type":"pong"}`)) // must not panic
}

func TestPionRecordsReachTheConnsDiagnostics(t *testing.T) {
	// pion must never reach os.Stderr on its own: webrtc's default factory logs
	// error records there, which is what buried the CLI's output in
	// `turnc ERROR: Fail to refresh permissions` walls.
	var logged []string
	var counted []slog.Level
	c := &Conn{
		opts: Options{
			Logf:       func(format string, args ...any) { logged = append(logged, fmt.Sprintf(format, args...)) },
			OnLinkDiag: func(_ string, level slog.Level, _ string) { counted = append(counted, level) },
		},
		done: make(chan struct{}),
	}

	c.pionLoggerFactory().NewLogger("turnc").Errorf("Fail to refresh permissions: %s", "broken pipe")

	if len(logged) != 1 || !strings.Contains(logged[0], "pion turnc: Fail to refresh permissions: broken pipe") {
		t.Errorf("pion record did not reach the diagnostic logger: %v", logged)
	}
	if len(counted) != 1 || counted[0] != slog.LevelError {
		t.Errorf("link diagnostics = %v, want one error", counted)
	}
}
