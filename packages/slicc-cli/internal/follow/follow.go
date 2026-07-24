// Package follow implements the follower-side handling of leader-issued exec
// requests: it runs each command locally (as the user), streams stdout/stderr
// back as exec.chunk, and replies with a terminal exec.response. It is used by
// the `follow` subcommand and exercised end-to-end by the WebRTC integration
// test.
package follow

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"sync"

	"github.com/ai-ecoverse/slicc-cli/internal/execrun"
	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
)

// Sender sends a JSON-serializable tray message to the leader.
type Sender interface {
	SendJSON(v any) error
}

// Session tracks in-flight leader-issued execs for one connection.
type Session struct {
	sender   Sender
	denyExec bool
	// Log receives one line per command as it starts (per-command visibility).
	log io.Writer

	mu      sync.Mutex
	running map[string]chan string
}

// NewSession builds a follow session. denyExec makes every exec.request refuse.
// log (optional) receives a one-line notice per command.
func NewSession(sender Sender, denyExec bool, log io.Writer) *Session {
	return &Session{sender: sender, denyExec: denyExec, log: log, running: make(map[string]chan string)}
}

// Handle routes an inbound message. Only exec.request / exec.signal are acted
// on; other types are ignored.
func (s *Session) Handle(ctx context.Context, msgType string, raw []byte) {
	switch msgType {
	case protocol.TypeExecRequest:
		var req protocol.ExecRequest
		if json.Unmarshal(raw, &req) != nil {
			return
		}
		if s.denyExec {
			_ = s.sender.SendJSON(protocol.ExecResponse{
				Type: protocol.TypeExecResponse, RequestID: req.RequestID, ExitCode: 127,
				Error: "exec disabled on this follower (--deny-exec)",
			})
			return
		}
		s.startExec(ctx, req)
	case protocol.TypeExecSignal:
		var sig protocol.ExecSignal
		if json.Unmarshal(raw, &sig) != nil {
			return
		}
		s.mu.Lock()
		ctrl := s.running[sig.RequestID]
		s.mu.Unlock()
		if ctrl != nil {
			select {
			case ctrl <- sig.Signal:
			default:
			}
		}
	}
}

func (s *Session) startExec(ctx context.Context, req protocol.ExecRequest) {
	if s.log != nil {
		fmt.Fprintf(s.log, "slicc follow: exec: %s\n", req.Command)
	}
	ctrl := make(chan string, 4)
	s.mu.Lock()
	s.running[req.RequestID] = ctrl
	s.mu.Unlock()

	go func() {
		res := execrun.Run(ctx, req.Command, execrun.Options{
			Cwd:     req.Cwd,
			Env:     req.Env,
			Control: ctrl,
			OnChunk: func(stream string, data []byte) {
				_ = s.sender.SendJSON(protocol.ExecChunk{
					Type: protocol.TypeExecChunk, RequestID: req.RequestID, Stream: stream,
					Data: base64.StdEncoding.EncodeToString(data),
				})
			},
		})
		resp := protocol.ExecResponse{
			Type: protocol.TypeExecResponse, RequestID: req.RequestID,
			ExitCode: res.ExitCode, Signal: res.Signal,
		}
		if res.Err != nil {
			resp.Error = res.Err.Error()
		}
		_ = s.sender.SendJSON(resp)
		s.mu.Lock()
		delete(s.running, req.RequestID)
		s.mu.Unlock()
	}()
}
