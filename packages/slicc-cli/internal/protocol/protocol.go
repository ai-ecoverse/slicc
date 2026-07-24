// Package protocol mirrors the tray sync data-channel wire contract from
// packages/shared-ts/src/tray-sync-protocol.ts. The CLI is a follower, so it
// only models the message variants it produces or consumes; everything else is
// ignored (decoded as an unknown type). Field names and JSON tags must match
// the TypeScript union exactly — the golden corpus test guards this.
package protocol

// TraySyncProtocolVersion mirrors TRAY_SYNC_PROTOCOL_VERSION.
const TraySyncProtocolVersion = 1

// RuntimeTag is the runtime the CLI attaches with (mirrors 'slicc-standalone').
const RuntimeTag = "slicc-cli"

// Capabilities is the additive `hello.capabilities` advertisement.
type Capabilities struct {
	// Exec marks this peer as able to run OS shell commands (the `follow` CLI).
	Exec bool `json:"exec,omitempty"`
}

// Hello is the additive version handshake both sides send first.
type Hello struct {
	Type            string        `json:"type"` // "hello"
	ProtocolVersion int           `json:"protocolVersion"`
	Runtime         string        `json:"runtime,omitempty"`
	Capabilities    *Capabilities `json:"capabilities,omitempty"`
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

// AgentEventEnvelope wraps a streamed agent event (leader→follower).
type AgentEventEnvelope struct {
	Type     string     `json:"type"` // "agent_event"
	Event    AgentEvent `json:"event"`
	ScoopJid string     `json:"scoopJid"`
}

// AgentEvent mirrors the subset of AgentEvent (agent-wire-types.ts) the CLI
// renders while streaming a turn. Unknown event `type`s are simply not printed.
type AgentEvent struct {
	Type      string `json:"type"`
	MessageID string `json:"messageId,omitempty"`
	Text      string `json:"text,omitempty"`
	ToolName  string `json:"toolName,omitempty"`
	Result    string `json:"result,omitempty"`
	IsError   *bool  `json:"isError,omitempty"`
	Error     string `json:"error,omitempty"`
}

// Envelope is used to sniff the discriminant `type` before full decoding.
type Envelope struct {
	Type string `json:"type"`
}

// Message type discriminants used across the CLI.
const (
	TypeHello        = "hello"
	TypePing         = "ping"
	TypePong         = "pong"
	TypeExecRequest  = "exec.request"
	TypeExecChunk    = "exec.chunk"
	TypeExecResponse = "exec.response"
	TypeExecSignal   = "exec.signal"
	TypeAgentEvent   = "agent_event"
	TypeError        = "error"

	StreamStdout = "stdout"
	StreamStderr = "stderr"

	AgentContentDelta = "content_delta"
	AgentTurnEnd      = "turn_end"
	AgentError        = "error"
	AgentToolUseStart = "tool_use_start"
	AgentToolResult   = "tool_result"
)
