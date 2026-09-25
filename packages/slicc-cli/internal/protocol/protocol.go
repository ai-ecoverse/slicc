




package protocol

import "encoding/json"
























const TraySyncProtocolVersion = 10


const RuntimeTag = "slicc-cli"


type Capabilities struct {
	
	
	
	
	
	
	
	Exec bool `json:"exec"`
	
	
	
	
	Browser      *bool `json:"browser,omitempty"`
	OAuthPopup   *bool `json:"oauthPopup,omitempty"`
	SudoApproval *bool `json:"sudoApproval,omitempty"`
	Biometric    *bool `json:"biometric,omitempty"`
	
	
	Computer *bool `json:"computer,omitempty"`
}


type Hello struct {
	Type            string        `json:"type"` 
	ProtocolVersion int           `json:"protocolVersion"`
	Runtime         string        `json:"runtime,omitempty"`
	Capabilities    *Capabilities `json:"capabilities,omitempty"`
	
	
	Motd string `json:"motd,omitempty"`
	
	
	
	
	
	
	
	
	PairID string `json:"pairId,omitempty"`
}


type ExecRequest struct {
	Type      string            `json:"type"` 
	RequestID string            `json:"requestId"`
	Command   string            `json:"command"`
	Cwd       string            `json:"cwd,omitempty"`
	Env       map[string]string `json:"env,omitempty"`
	
	Stdin string `json:"stdin,omitempty"`
}


type ExecChunk struct {
	Type      string `json:"type"` 
	RequestID string `json:"requestId"`
	Stream    string `json:"stream"` 
	Data      string `json:"data"`   
}


type ExecResponse struct {
	Type      string `json:"type"` 
	RequestID string `json:"requestId"`
	ExitCode  int    `json:"exitCode"`
	Signal    string `json:"signal,omitempty"`
	Error     string `json:"error,omitempty"`
}


type ExecSignal struct {
	Type      string `json:"type"` 
	RequestID string `json:"requestId"`
	Signal    string `json:"signal"` 
}


type UserMessage struct {
	Type      string `json:"type"` 
	Text      string `json:"text"`
	MessageID string `json:"messageId"`
}


type Abort struct {
	Type string `json:"type"` 
}


type Ping struct {
	Type string `json:"type"` 
}


type Pong struct {
	Type string `json:"type"` 
}




type Status struct {
	Type        string `json:"type"` 
	ScoopStatus string `json:"scoopStatus"`
	ScoopJid    string `json:"scoopJid,omitempty"`
}


type AgentEventEnvelope struct {
	Type     string     `json:"type"` 
	Event    AgentEvent `json:"event"`
	ScoopJid string     `json:"scoopJid"`
}



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




type UserMessageEcho struct {
	Type      string `json:"type"` 
	Text      string `json:"text"`
	MessageID string `json:"messageId,omitempty"`
	ScoopJid  string `json:"scoopJid,omitempty"`
}





type NewSession struct {
	Type   string `json:"type"` 
	Action string `json:"action"`
}



type RequestSnapshot struct {
	Type     string `json:"type"` 
	ScoopJid string `json:"scoopJid,omitempty"`
	Peek     bool   `json:"peek,omitempty"`
}



type Snapshot struct {
	Type     string            `json:"type"` 
	Messages []json.RawMessage `json:"messages"`
	ScoopJid string            `json:"scoopJid"`
}


type ModelsRequest struct {
	Type string `json:"type"` 
}



type ModelCatalogEntry struct {
	ProviderName string `json:"providerName"`
	ModelID      string `json:"modelId"`
	ModelName    string `json:"modelName"`
	Reasoning    bool   `json:"reasoning"`
}


type ModelsList struct {
	Type   string              `json:"type"` 
	Models []ModelCatalogEntry `json:"models"`
}



type ModelSelect struct {
	Type     string `json:"type"` 
	ModelID  string `json:"modelId"`
	ScoopJid string `json:"scoopJid,omitempty"`
}


type ModelSelectionState struct {
	ActiveModelID  string `json:"activeModelId"`
	ScoopJid       string `json:"scoopJid"`
	ThinkingLevel  string `json:"thinkingLevel,omitempty"`
	EffortOverride string `json:"effortOverride,omitempty"`
}


type ModelState struct {
	Type  string              `json:"type"` 
	State ModelSelectionState `json:"state"`
}


type Envelope struct {
	Type string `json:"type"`
}












type ChunkFrame struct {
	Type        string `json:"type"`
	ChunkID     string `json:"chunkId"`
	ChunkIndex  int    `json:"chunkIndex"`
	TotalChunks int    `json:"totalChunks"`
	ChunkData   string `json:"chunkData"`
}


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
	TypeNewSession      = "new_session"
	TypeRequestSnapshot = "request_snapshot"
	TypeSnapshot        = "snapshot"
	TypeModelsRequest   = "models.request"
	TypeModelsList      = "models.list"
	TypeModelSelect     = "model.select"
	TypeModelState      = "model.state"
	TypeError           = "error"

	
	
	
	TypeChunk = "__chunk"

	StreamStdout = "stdout"
	StreamStderr = "stderr"

	ScoopStatusProcessing = "processing"

	AgentMessageStart = "message_start"
	AgentContentDelta = "content_delta"
	AgentContentDone  = "content_done"
	AgentTurnEnd      = "turn_end"
	AgentError        = "error"
	AgentToolUseStart = "tool_use_start"
	AgentToolResult   = "tool_result"
)
