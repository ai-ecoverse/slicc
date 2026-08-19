// Package tray connects to a SLICC leader as a follower over WebRTC (pion) and
// exposes the tray-control data channel as a JSON send/receive surface. It runs
// the signaling attach + bootstrap loop, answers the leader's SDP offer, trickles
// ICE, and — once the leader-created "tray-control" channel opens — sends the
// `hello` handshake and dispatches inbound messages (auto-answering ping/pong).
package tray

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/pion/ice/v4"
	pionlogging "github.com/pion/logging"
	"github.com/pion/webrtc/v4"

	"github.com/ai-ecoverse/slicc-cli/internal/logging"
	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
	"github.com/ai-ecoverse/slicc-cli/internal/signaling"
)

// dataChannelLabel mirrors DEFAULT_DATA_CHANNEL_LABEL in tray-webrtc.ts.
const dataChannelLabel = "tray-control"

const (
	pollInterval        = 1 * time.Second
	bootstrapMaxWait    = 30 * time.Second
	maxBufferedAmount   = 1 << 20 // 1 MiB — apply backpressure above this
	maxSupersedeRetries = 5
)

// Transport chunking bounds. These mirror the TS constants in
// packages/shared-ts/src/tray-sync-protocol.ts; see ChunkFrame for why framing
// lives below the message discriminants.
const (
	// maxMessageBytes is the per-send SCTP ceiling. 65536 is the floor every
	// SCTP implementation must accept (RFC 8831 §6.6), so framing to it is
	// always safe regardless of what the peer negotiated.
	maxMessageBytes = 65536
	// chunkEnvelopeBytes is the allowance for a frame's type/id/index fields.
	chunkEnvelopeBytes = 512
	// worstCaseBytesPerRune bounds the growth of a slice of already-serialized
	// JSON when it is re-escaped into a frame: a non-ASCII BMP rune costs 3
	// UTF-8 bytes, re-escaped ASCII (`\` → `\\`) costs 2. 4 leaves margin.
	worstCaseBytesPerRune = 4
	// maxChunkBytes caps frame payload, matching the TS chunkers.
	maxChunkBytes = 32 * 1024
	// maxTotalMessageBytes is the hard ceiling on one reassembled message.
	maxTotalMessageBytes = 8 << 20 // 8 MiB
	// maxPendingReassemblies bounds concurrent in-flight reassemblies.
	maxPendingReassemblies = 8
	// maxChunkCount bounds the per-frame bookkeeping allocated from a peer's
	// claimed TotalChunks, before any payload has arrived.
	maxChunkCount = 8192
)

// Options configures a Dial.
type Options struct {
	// Runtime tag advertised on attach + hello (default protocol.RuntimeTag).
	Runtime string
	// Capabilities advertised on hello (e.g. {Exec:true} for `follow`).
	Capabilities *protocol.Capabilities
	// Motd is an optional one-line description advertised on hello; the leader
	// surfaces it to the agent (e.g. `ssh --list`). Empty → field omitted.
	Motd string
	// OnMessage receives every inbound message except ping/pong (auto-handled).
	// It runs on the data-channel read goroutine; keep it non-blocking.
	OnMessage func(msgType string, raw []byte)
	// OnActivity fires for every inbound frame, including keepalives and the
	// transport framing OnMessage never sees. Any frame is proof the leader is
	// alive; keepalives alone are not enough, because the leader answers pings
	// rather than sending them. Runs on the data-channel read goroutine; keep it
	// non-blocking.
	OnActivity func()
	// OnLinkDiag taps pion's own records (ICE state churn, TURN refresh
	// failures) so a caller can summarize them — a counter in a status bar —
	// instead of letting them scroll. Runs on pion goroutines; keep it
	// non-blocking and concurrency-safe.
	OnLinkDiag logging.PionEvent
	// Logf is an optional diagnostic logger.
	Logf func(format string, args ...any)
	// HTTPClient overrides the signaling HTTP client (tests). nil → default.
	HTTPClient *http.Client
}

func (o Options) logf(format string, args ...any) {
	if o.Logf != nil {
		o.Logf(format, args...)
	}
}

// Conn is a live follower connection to a leader.
type Conn struct {
	pc   *webrtc.PeerConnection
	opts Options

	mu sync.Mutex
	dc *webrtc.DataChannel

	sendMu sync.Mutex

	// reassemblyMu guards reassembly; dispatch runs on the data-channel read
	// goroutine, so inbound frames arrive serially, but Close may race it.
	reassemblyMu  sync.Mutex
	reassembly    map[string]*chunkReassembly
	reassemblySeq uint64

	connected chan struct{}
	done      chan struct{}
	closeOnce sync.Once

	// ctx is cancelled when the connection ends (Close or a dead peer), bounding
	// the lifetime of fire-and-forget ICE candidate posts to the connection.
	ctx    context.Context
	cancel context.CancelFunc
}

// Dial attaches to the leader at joinURL and returns once the data channel is
// open and the `hello` handshake has been sent.
func Dial(ctx context.Context, joinURL string, opts Options) (*Conn, error) {
	if opts.Runtime == "" {
		opts.Runtime = protocol.RuntimeTag
	}
	controllerID := newUUID()
	currentURL := joinURL
	redirects := 0

	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		sig := signaling.New(currentURL, opts.HTTPClient)

		// Attach loop: retry on `wait`, proceed on `signal`, redirect on supersede.
		plan, err := attachWait(ctx, sig, controllerID, opts.Runtime, opts.logf)
		if err != nil {
			return nil, err
		}
		switch plan.Action {
		case "signal":
			if plan.Bootstrap == nil {
				return nil, fmt.Errorf("tray attach: signal without bootstrap")
			}
			return dialBootstrap(ctx, sig, controllerID, plan, opts)
		case "fail":
			if plan.Code == "TRAY_SUPERSEDED" && plan.JoinURL != "" && redirects < maxSupersedeRetries {
				redirects++
				currentURL = plan.JoinURL
				controllerID = newUUID()
				opts.logf("tray attach superseded; following redirect (%d/%d)", redirects, maxSupersedeRetries)
				continue
			}
			return nil, fmt.Errorf("tray attach failed (%s): %s", plan.Code, plan.Error)
		default:
			return nil, fmt.Errorf("tray attach: unexpected action %q", plan.Action)
		}
	}
}

func attachWait(ctx context.Context, sig *signaling.Client, controllerID, runtime string, logf func(string, ...any)) (*signaling.AttachPlan, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		plan, err := sig.Attach(ctx, controllerID, runtime)
		if err != nil {
			return nil, err
		}
		if plan.Action != "wait" {
			return plan, nil
		}
		logf("tray attach: waiting for leader (%s), retrying in %dms", plan.Code, plan.RetryAfterMs)
		if !sleep(ctx, time.Duration(plan.RetryAfterMs)*time.Millisecond) {
			return nil, ctx.Err()
		}
	}
}

func dialBootstrap(ctx context.Context, sig *signaling.Client, controllerID string, plan *signaling.AttachPlan, opts Options) (*Conn, error) {
	connCtx, cancel := context.WithCancel(ctx)
	c := &Conn{
		opts:      opts,
		connected: make(chan struct{}),
		done:      make(chan struct{}),
		ctx:       connCtx,
		cancel:    cancel,
	}
	currentBootstrapID := plan.Bootstrap.BootstrapID

	if err := c.configurePeer(plan.IceServers, sig, controllerID, &currentBootstrapID); err != nil {
		return nil, err
	}

	deadline := time.Now().Add(bootstrapMaxWait)
	cursor := 0
	bootstrapID := plan.Bootstrap.BootstrapID
	// Seed the offer that may already be in the attach bootstrap's event stream
	// by polling immediately.
	for {
		select {
		case <-c.connected:
			if err := c.sendHello(); err != nil {
				c.Close()
				return nil, err
			}
			opts.logf("tray connected (bootstrap %s)", bootstrapID)
			return c, nil
		case <-ctx.Done():
			c.Close()
			return nil, ctx.Err()
		default:
		}
		if time.Now().After(deadline) {
			c.Close()
			return nil, fmt.Errorf("tray connect timed out after %s", bootstrapMaxWait)
		}

		poll, err := sig.Poll(ctx, controllerID, bootstrapID, cursor)
		if err != nil {
			c.Close()
			return nil, err
		}
		bootstrapID = poll.Bootstrap.BootstrapID
		cursor = poll.Bootstrap.Cursor
		c.setBootstrapID(&currentBootstrapID, bootstrapID)

		retryBootstrap, err := c.processEvents(ctx, sig, controllerID, bootstrapID, poll)
		if err != nil {
			c.Close()
			return nil, err
		}
		if retryBootstrap != "" {
			// A retryable failure minted a fresh bootstrap; reset the peer.
			bootstrapID = retryBootstrap
			cursor = 0
			if err := c.recreatePeer(plan.IceServers, sig, controllerID, &currentBootstrapID); err != nil {
				c.Close()
				return nil, err
			}
			c.setBootstrapID(&currentBootstrapID, bootstrapID)
			continue
		}

		if !sleep(ctx, pollInterval) {
			c.Close()
			return nil, ctx.Err()
		}
	}
}

// processEvents applies offer/ice/failed events. Returns a non-empty bootstrap
// id when a retryable failure minted a fresh one; the caller then resets.
func (c *Conn) processEvents(ctx context.Context, sig *signaling.Client, controllerID, bootstrapID string, poll *signaling.BootstrapPlan) (string, error) {
	for _, ev := range poll.Events {
		switch ev.Type {
		case "bootstrap.offer":
			if ev.Offer == nil {
				continue
			}
			answerSDP, err := c.answerOffer(ev.Offer.SDP)
			if err != nil {
				return "", fmt.Errorf("tray answer: %w", err)
			}
			if _, err := sig.SendAnswer(ctx, controllerID, bootstrapID, answerSDP); err != nil {
				return "", err
			}
		case "bootstrap.ice_candidate":
			if ev.Candidate == nil {
				continue
			}
			if err := c.addRemoteCandidate(*ev.Candidate); err != nil {
				c.opts.logf("tray: failed to add remote ICE candidate: %v", err)
			}
		case "bootstrap.failed":
			msg := "bootstrap failed"
			if ev.Failure != nil {
				msg = ev.Failure.Message
			}
			if ev.Failure != nil && ev.Failure.Retryable && poll.Bootstrap.RetriesRemaining > 0 {
				retry, err := sig.Retry(ctx, controllerID, bootstrapID, c.opts.Runtime)
				if err != nil {
					return "", err
				}
				return retry.Bootstrap.BootstrapID, nil
			}
			return "", fmt.Errorf("tray %s", msg)
		}
	}
	return "", nil
}

func (c *Conn) configurePeer(iceServers []signaling.TurnIceServer, sig *signaling.Client, controllerID string, bootstrapIDRef *string) error {
	config := webrtc.Configuration{ICEServers: toPionICE(iceServers)}
	// Chrome hides host candidates behind mDNS (.local) names; resolve them so a
	// browser leader on the same host or LAN can connect with host candidates and
	// no TURN.
	settingEngine := webrtc.SettingEngine{}
	settingEngine.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryOnly)
	settingEngine.LoggerFactory = c.pionLoggerFactory()
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine))
	pc, err := api.NewPeerConnection(config)
	if err != nil {
		return fmt.Errorf("tray: create peer connection: %w", err)
	}
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != dataChannelLabel {
			return
		}
		c.mu.Lock()
		c.dc = dc
		c.mu.Unlock()
		dc.OnOpen(func() {
			c.signalConnected()
		})
		dc.OnMessage(func(msg webrtc.DataChannelMessage) {
			c.dispatch(msg.Data)
		})
	})
	pc.OnICECandidate(func(cand *webrtc.ICECandidate) {
		if cand == nil {
			return
		}
		c.sendLocalCandidate(c.ctx, sig, controllerID, bootstrapIDRef, cand)
	})
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		switch state {
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed, webrtc.PeerConnectionStateDisconnected:
			c.markDone()
		}
	})
	c.mu.Lock()
	c.pc = pc
	c.mu.Unlock()
	return nil
}

// pionLoggerFactory is the logging pion gets on every peer connection.
//
// It must be installed explicitly: with SettingEngine.LoggerFactory left nil,
// webrtc falls back to pion/logging.NewDefaultLoggerFactory(), which writes
// error records straight to os.Stderr — a flaky TURN allocation then buries the
// CLI's own output under `turnc ERROR: Fail to refresh permissions` lines that
// no log level of ours can quiet.
func (c *Conn) pionLoggerFactory() pionlogging.LoggerFactory {
	return logging.PionFactory(c.opts.Logf, c.opts.OnLinkDiag)
}

func (c *Conn) recreatePeer(iceServers []signaling.TurnIceServer, sig *signaling.Client, controllerID string, bootstrapIDRef *string) error {
	c.mu.Lock()
	old := c.pc
	c.pc = nil
	c.dc = nil
	c.mu.Unlock()
	if old != nil {
		_ = old.Close()
	}
	return c.configurePeer(iceServers, sig, controllerID, bootstrapIDRef)
}

func (c *Conn) answerOffer(offerSDP string) (string, error) {
	c.mu.Lock()
	pc := c.pc
	c.mu.Unlock()
	if pc == nil {
		return "", fmt.Errorf("no peer connection")
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offerSDP}); err != nil {
		return "", err
	}
	answer, err := pc.CreateAnswer(nil)
	if err != nil {
		return "", err
	}
	if err := pc.SetLocalDescription(answer); err != nil {
		return "", err
	}
	return answer.SDP, nil
}

func (c *Conn) addRemoteCandidate(cand signaling.IceCandidate) error {
	c.mu.Lock()
	pc := c.pc
	c.mu.Unlock()
	if pc == nil {
		return fmt.Errorf("no peer connection")
	}
	init := webrtc.ICECandidateInit{Candidate: cand.Candidate}
	if cand.SDPMid != nil {
		init.SDPMid = cand.SDPMid
	}
	if cand.SDPMLineIndex != nil {
		idx := uint16(*cand.SDPMLineIndex)
		init.SDPMLineIndex = &idx
	}
	return pc.AddICECandidate(init)
}

func (c *Conn) sendLocalCandidate(ctx context.Context, sig *signaling.Client, controllerID string, bootstrapIDRef *string, cand *webrtc.ICECandidate) {
	c.mu.Lock()
	bootstrapID := *bootstrapIDRef
	c.mu.Unlock()
	if bootstrapID == "" {
		return
	}
	init := cand.ToJSON()
	trayCand := signaling.IceCandidate{Candidate: init.Candidate}
	trayCand.SDPMid = init.SDPMid
	if init.SDPMLineIndex != nil {
		idx := int(*init.SDPMLineIndex)
		trayCand.SDPMLineIndex = &idx
	}
	// Fire-and-forget, matching the TS + iOS followers.
	go func() {
		if _, err := sig.SendICECandidate(ctx, controllerID, bootstrapID, trayCand); err != nil {
			c.opts.logf("tray: failed to send local ICE candidate: %v", err)
		}
	}()
}

func (c *Conn) setBootstrapID(ref *string, id string) {
	c.mu.Lock()
	*ref = id
	c.mu.Unlock()
}

// chunkReassembly accumulates the frames of one chunked message.
type chunkReassembly struct {
	chunks []string
	// seen tracks arrival per index. A separate flag rather than an
	// empty-string sentinel, so an empty ChunkData is distinguished from a
	// missing frame the way the TS and Swift receivers distinguish them.
	seen     []bool
	received int
	bytes    int
	// seq orders entries by insertion for oldest-first eviction. Not wall
	// time: time.Now() is coarse enough on Windows that entries started in
	// the same tick tie, and map iteration then evicts an arbitrary one.
	seq uint64
}

// dispatch decodes the discriminant and routes inbound messages.
func (c *Conn) dispatch(data []byte) {
	if c.opts.OnActivity != nil {
		c.opts.OnActivity()
	}
	var env protocol.Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		c.opts.logf("tray: dropping unparseable message: %v", err)
		return
	}
	// Transport frames are intercepted before the type switch: reassembly
	// completes into an ordinary message, so OnMessage never sees framing.
	if env.Type == protocol.TypeChunk {
		c.acceptChunkFrame(data)
		return
	}
	switch env.Type {
	case protocol.TypePing:
		_ = c.SendJSON(protocol.Pong{Type: protocol.TypePong})
	case protocol.TypePong:
		// no-op
	default:
		if c.opts.OnMessage != nil {
			c.opts.OnMessage(env.Type, data)
		}
	}
}

// acceptChunkFrame buffers one inbound frame and, once the last one lands,
// re-dispatches the reconstructed message.
//
// Bounded by maxPendingReassemblies and maxTotalMessageBytes, evicting
// oldest-first: a peer that starts many large messages and finishes none must
// not grow this process without limit. Frames are index-addressed, so
// out-of-order delivery is handled even though SCTP is ordered by default.
func (c *Conn) acceptChunkFrame(data []byte) {
	var frame protocol.ChunkFrame
	if err := json.Unmarshal(data, &frame); err != nil {
		c.opts.logf("tray: dropping unparseable chunk frame: %v", err)
		return
	}
	if frame.TotalChunks <= 0 || frame.ChunkIndex < 0 || frame.ChunkIndex >= frame.TotalChunks {
		c.opts.logf("tray: dropping chunk frame with bad indices %d/%d",
			frame.ChunkIndex, frame.TotalChunks)
		return
	}
	if frame.TotalChunks > maxChunkCount {
		c.opts.logf("tray: dropping chunk frame claiming %d frames (max %d)",
			frame.TotalChunks, maxChunkCount)
		return
	}

	c.reassemblyMu.Lock()
	if c.reassembly == nil {
		c.reassembly = make(map[string]*chunkReassembly)
	}
	entry, ok := c.reassembly[frame.ChunkID]
	if ok && len(entry.chunks) != frame.TotalChunks {
		// TotalChunks must not change mid-message. Without this, a later frame
		// re-declaring a larger count indexes past the buffer sized by the first
		// one and panics the data-channel read goroutine — a remote crash.
		c.reassemblyMu.Unlock()
		c.opts.logf("tray: dropping chunk frame with inconsistent totalChunks (%d, want %d)",
			frame.TotalChunks, len(entry.chunks))
		return
	}
	if !ok {
		c.reassemblySeq++
		entry = &chunkReassembly{
			chunks: make([]string, frame.TotalChunks),
			seen:   make([]bool, frame.TotalChunks),
			seq:    c.reassemblySeq,
		}
		c.reassembly[frame.ChunkID] = entry
		c.evictOldestReassemblyLocked()
	}
	if entry.seen[frame.ChunkIndex] {
		c.reassemblyMu.Unlock() // duplicate frame
		return
	}
	entry.chunks[frame.ChunkIndex] = frame.ChunkData
	entry.seen[frame.ChunkIndex] = true
	entry.received++
	entry.bytes += len(frame.ChunkData)
	if entry.bytes > maxTotalMessageBytes {
		delete(c.reassembly, frame.ChunkID)
		c.reassemblyMu.Unlock()
		c.opts.logf("tray: dropping oversize chunked message %s (>%d bytes)",
			frame.ChunkID, maxTotalMessageBytes)
		return
	}
	if entry.received < frame.TotalChunks {
		c.reassemblyMu.Unlock()
		return
	}
	delete(c.reassembly, frame.ChunkID)
	c.reassemblyMu.Unlock()

	c.dispatch([]byte(strings.Join(entry.chunks, "")))
}

// evictOldestReassemblyLocked drops the oldest in-flight reassembly while the
// pending count is over budget. Caller must hold reassemblyMu.
func (c *Conn) evictOldestReassemblyLocked() {
	for len(c.reassembly) > maxPendingReassemblies {
		// Selection is tracked with an explicit flag: the empty string is a
		// syntactically valid chunkId, so it cannot double as "none selected".
		var oldestID string
		var oldest uint64
		found := false
		for id, entry := range c.reassembly {
			if !found || entry.seq < oldest {
				oldestID, oldest = id, entry.seq
				found = true
			}
		}
		if !found {
			return
		}
		delete(c.reassembly, oldestID)
		c.opts.logf("tray: evicted incomplete reassembly %s", oldestID)
	}
}

func (c *Conn) sendHello() error {
	return c.SendJSON(protocol.Hello{
		Type:            protocol.TypeHello,
		ProtocolVersion: protocol.TraySyncProtocolVersion,
		Runtime:         c.opts.Runtime,
		Capabilities:    c.opts.Capabilities,
		Motd:            c.opts.Motd,
	})
}

// SendJSON marshals v and sends it over the data channel, applying simple
// backpressure when the SCTP send buffer is backed up.
//
// A message larger than maxMessageBytes is split into chunk frames rather than
// handed to SendText, which would fail for exceeding the SCTP max message size
// and drop the message.
func (c *Conn) SendJSON(v any) error {
	payload, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if len(payload) > maxTotalMessageBytes {
		return fmt.Errorf("tray: refusing to send %d-byte message (limit %d)",
			len(payload), maxTotalMessageBytes)
	}
	if len(payload) <= maxMessageBytes {
		return c.sendRaw(string(payload))
	}
	for _, frame := range frameChunks(string(payload), newChunkID()) {
		encoded, err := json.Marshal(frame)
		if err != nil {
			return err
		}
		if err := c.sendRaw(string(encoded)); err != nil {
			return fmt.Errorf("tray: chunked send failed at frame %d/%d: %w",
				frame.ChunkIndex, frame.TotalChunks, err)
		}
	}
	return nil
}

// sendRaw writes one already-serialized frame, waiting for the SCTP buffer to
// drain first.
func (c *Conn) sendRaw(payload string) error {
	c.mu.Lock()
	dc := c.dc
	c.mu.Unlock()
	if dc == nil {
		return fmt.Errorf("tray: data channel not open")
	}
	// Backpressure: wait for the buffer to drain before piling on more.
	for i := 0; dc.BufferedAmount() > maxBufferedAmount && i < 1000; i++ {
		select {
		case <-c.done:
			return fmt.Errorf("tray: connection closed")
		case <-time.After(5 * time.Millisecond):
		}
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	return dc.SendText(payload)
}

// newChunkID returns an identifier unique among this process's in-flight
// chunked messages.
func newChunkID() string {
	var buf [8]byte
	if _, err := rand.Read(buf[:]); err != nil {
		return fmt.Sprintf("c%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("c%x", buf)
}

// frameChunks splits an already-serialized message into frames that each fit
// within maxMessageBytes once re-escaped as JSON.
//
// Slicing is done on bytes, but only at rune boundaries: cutting a multi-byte
// rune in half would corrupt both frames, and Go strings carry raw UTF-8 (no
// surrogate-escape safety net).
func frameChunks(payload, chunkID string) []protocol.ChunkFrame {
	budget := (maxMessageBytes - chunkEnvelopeBytes) / worstCaseBytesPerRune
	if budget > maxChunkBytes {
		budget = maxChunkBytes
	}
	if budget < 1 {
		budget = 1
	}

	var slices []string
	for start := 0; start < len(payload); {
		end := start + budget
		if end >= len(payload) {
			end = len(payload)
		} else {
			for end > start && !utf8.RuneStart(payload[end]) {
				end--
			}
			if end == start {
				end = start + budget // pathological; accept the split
			}
		}
		slices = append(slices, payload[start:end])
		start = end
	}
	if len(slices) == 0 {
		slices = []string{""}
	}

	frames := make([]protocol.ChunkFrame, len(slices))
	for i, slice := range slices {
		frames[i] = protocol.ChunkFrame{
			Type:        protocol.TypeChunk,
			ChunkID:     chunkID,
			ChunkIndex:  i,
			TotalChunks: len(slices),
			ChunkData:   slice,
		}
	}
	return frames
}

// Done is closed when the connection drops.
func (c *Conn) Done() <-chan struct{} { return c.done }

// Close tears down the peer connection. Teardown errors are not actionable, so
// it returns nothing.
func (c *Conn) Close() {
	c.markDone()
	c.mu.Lock()
	pc := c.pc
	c.pc = nil
	c.mu.Unlock()
	if pc != nil {
		_ = pc.Close()
	}
}

func (c *Conn) markDone() {
	c.closeOnce.Do(func() {
		close(c.done)
		if c.cancel != nil {
			c.cancel()
		}
	})
}

// signalConnected marks the connected channel closed exactly once.
func (c *Conn) signalConnected() {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.connected:
	default:
		close(c.connected)
	}
}

// --- helpers -----------------------------------------------------------------

func toPionICE(servers []signaling.TurnIceServer) []webrtc.ICEServer {
	out := make([]webrtc.ICEServer, 0, len(servers))
	for _, s := range servers {
		ice := webrtc.ICEServer{URLs: s.URLs}
		if s.Username != "" || s.Credential != "" {
			ice.Username = s.Username
			ice.Credential = s.Credential
		}
		out = append(out, ice)
	}
	return out
}

func sleep(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
