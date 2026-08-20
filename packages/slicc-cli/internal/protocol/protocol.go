// Package protocol mirrors the tray sync data-channel wire contract from
// packages/shared-ts/src/tray-sync-protocol.ts. The CLI is a follower, so it
// only models the message variants it produces or consumes; everything else is
// ignored (decoded as an unknown type). Field names and JSON tags must match
// the TypeScript union exactly — the golden corpus test guards this.
package protocol

import "encoding/json"

// TraySyncProtocolVersion mirrors TRAY_SYNC_PROTOCOL_VERSION.
//
// v6 added `tab.teleport.request` (a follower asking the leader to open a tray
// tab locally, carrying its cookies + web storage). The CLI is exec-only — it
// hosts no browser targets and never originates or handles it — so the bump is
// version bookkeeping, not new surface here. Leaving `capabilities.browser`
// unset (this struct has no such field) is what keeps a v6 leader from ever
// selecting this follower as a teleport destination: its `tab.open` would hang
// rather than fail, so the leader now requires the flag instead of optimistically
// assuming an un-advertised follower can serve one.
const TraySyncProtocolVersion = 7

// RuntimeTag is the runtime the CLI attaches with (mirrors 'slicc-standalone').
const RuntimeTag = "slicc-cli"

// Capabilities is the additive `hello.capabilities` advertisement.
type Capabilities struct {
	// Exec marks this peer as able to run OS shell commands (the `follow` CLI).
	//
	// No `omitempty`: a peer that sends `capabilities` at all is making a
	// statement, and `omitempty` would erase an explicit `exec: false` into an
	// absent field. The leader's gate reads `peerCapabilities?.exec`, so the
	// two behave alike today — but only one of them survives a round-trip, and
	// the iOS follower does send an explicit false.
	Exec bool `json:"exec"`
	// Browser / OAuthPopup / SudoApproval / Biometric are additive flags the
	// browser and iOS followers advertise (v7 added the sudo pair, #2062).
	// The CLI never sets them; they are modeled so a corpus round-trip keeps
	// every field a real peer sends.
	Browser      *bool `json:"browser,omitempty"`
	OAuthPopup   *bool `json:"oauthPopup,omitempty"`
	SudoApproval *bool `json:"sudoApproval,omitempty"`
	Biometric    *bool `json:"biometric,omitempty"`
}

// Hello is the additive version handshake both sides send first.
type Hello struct {
	Type            string        `json:"type"` // "hello"
	ProtocolVersion int           `json:"protocolVersion"`
	Runtime         string        `json:"runtime,omitempty"`
	Capabilities    *Capabilities `json:"capabilities,omitempty"`
	// Motd is an optional one-line description the leader surfaces to the agent
	// (e.g. `ssh --list`) — who/what the exec target is. Additive + optional.
	Motd string `json:"motd,omitempty"`
}

// ExecRequest asks the receiving peer to run a shell command.
type ExecRequest struct {
	Type      string            `json:"type"` // "exec.request"
	RequestID string            `json:"requestId"`
	Command   string            `json:"command"`
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
}

// ExecChunk is one streamed stdout/stderr block; Data is base64-encoded bytes.
type ExecChunk struct {
	Type      string `json:"type"` // "exec.chunk"
	RequestID string `json:"requestId"`
	Stream    string `json:"stream"` // "stdout" | "stderr"
	Data      string `json:"data"`   // base64
}

// ExecResponse is the terminal reply for an ExecRequest.
type ExecResponse struct {
	Type      string `json:"type"` // "exec.response"
	RequestID string `json:"requestId"`
	ExitCode  int    `json:"exitCode"`
	Signal    string `json:"signal,omitempty"`
	Error     string `json:"error,omitempty"`
}

// ExecSignal cancels a running ExecRequest.
type ExecSignal struct {
	Type      string `json:"type"` // "exec.signal"
	RequestID string `json:"requestId"`
	Signal    string `json:"signal"` // "SIGINT" | "SIGTERM" | "SIGKILL"
}

// UserMessage is a chat turn sent to the leader (the `prompt` subcommand).
type UserMessage struct {
	Type      string `json:"type"` // "user_message"
	Text      string `json:"text"`
	MessageID string `json:"messageId"`
}

// Abort cancels the leader's in-flight turn.
type Abort struct {
	Type string `json:"type"` // "abort"
}

// Ping is a liveness probe.
type Ping struct {
	Type string `json:"type"` // "ping"
}

// Pong is a liveness reply.
type Pong struct {
	Type string `json:"type"` // "pong"
}

// Status is a scoop processing-state update (leader→follower). On a live browser
// float the leader emits no `turn_end` agent event; a turn's completion shows up
// as scoopStatus going "processing" → "ready", which is how `prompt` ends.
type Status struct {
	Type        string `json:"type"` // "status"
	ScoopStatus string `json:"scoopStatus"`
	ScoopJid    string `json:"scoopJid,omitempty"`
}

// AgentEventEnvelope wraps a streamed agent event (leader→follower).
type AgentEventEnvelope struct {
	Type     string     `json:"type"` // "agent_event"
	Event    AgentEvent `json:"event"`
	ScoopJid string     `json:"scoopJid"`
}

// AgentEvent mirrors the subset of AgentEvent (agent-wire-types.ts) the CLI
// renders while streaming a turn. Unknown event `type`s are simply not printed.
type AgentEvent struct {
	Type      string          `json:"type"`
	MessageID string          `json:"messageId,omitempty"`
	Text      string          `json:"text,omitempty"`
	ToolName  string          `json:"toolName,omitempty"`
	ToolInput json.RawMessage `json:"toolInput,omitempty"`
	Result    string          `json:"result,omitempty"`
	IsError   *bool           `json:"isError,omitempty"`
	Error     string          `json:"error,omitempty"`
}

// UserMessageEcho is the leader's echo of a user message to followers (the
// human's prompt); `watch` renders it so the CLI shows the same thread the
// browser does.
type UserMessageEcho struct {
	Type      string `json:"type"` // "user_message_echo"
	Text      string `json:"text"`
	MessageID string `json:"messageId,omitempty"`
	ScoopJid  string `json:"scoopJid,omitempty"`
}

// Envelope is used to sniff the discriminant `type` before full decoding.
type Envelope struct {
	Type string `json:"type"`
}

// ChunkFrame is one frame of a message too large for a single SCTP send.
//
// It mirrors TrayChunkFrame in packages/shared-ts/src/tray-sync-protocol.ts and
// deliberately sits BELOW the message discriminants above: a sender splits an
// oversize serialized message into frames, and a receiver reassembles them
// before looking at `type` at all. That is why it needs no entry in the golden
// corpus (which enumerates the message unions) and why Conn.dispatch intercepts
// it ahead of the type switch.
//
// ChunkData slices are concatenated in ChunkIndex order to recover the original
// message bytes.
type ChunkFrame struct {
	Type        string `json:"type"`
	ChunkID     string `json:"chunkId"`
	ChunkIndex  int    `json:"chunkIndex"`
	TotalChunks int    `json:"totalChunks"`
	ChunkData   string `json:"chunkData"`
}

// Message type discriminants used across the CLI.
const (
	TypeHello           = "hello"
	TypePing            = "ping"
	TypePong            = "pong"
	TypeExecRequest     = "exec.request"
	TypeExecChunk       = "exec.chunk"
	TypeExecResponse    = "exec.response"
	TypeExecSignal      = "exec.signal"
	TypeAgentEvent      = "agent_event"
	TypeUserMessageEcho = "user_message_echo"
	TypeStatus          = "status"
	TypeError           = "error"

	// TypeChunk is the transport-level chunk frame (see ChunkFrame). The `__`
	// prefix marks reserved transport vocabulary that can never collide with a
	// semantic message type.
	TypeChunk = "__chunk"

	StreamStdout = "stdout"
	StreamStderr = "stderr"

	ScoopStatusProcessing = "processing"

	AgentContentDelta = "content_delta"
	AgentContentDone  = "content_done"
	AgentTurnEnd      = "turn_end"
	AgentError        = "error"
	AgentToolUseStart = "tool_use_start"
	AgentToolResult   = "tool_result"
)
