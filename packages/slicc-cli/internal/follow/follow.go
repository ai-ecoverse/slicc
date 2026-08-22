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
	sender Sender
	// runner is the argv each command is handed to (command appended as the final
	// arg). Empty means exec is disabled: every exec.request is refused.
	runner []string
	// eval, when set, replaces per-command runner spawns with a persistent REPL
	// session: each command is written as a line to its stdin (see
	// execrun.EvalSession). The eval session outlives this connection so REPL
	// state survives reconnects.
	eval *execrun.EvalSession
	// log receives one line per command as it starts (per-command visibility).
	// The line carries no CLI prefix: the writer the caller passes owns the
	// presentation (the `follow` console prefixes or decorates it).
	log io.Writer

	mu      sync.Mutex
	running map[string]chan string
}

// NewSession builds a follow session. An empty runner makes every exec.request
// refuse; a non-empty runner (e.g. ["bash","-c"]) runs each command through it.
// log (optional) receives a one-line notice per command.
func NewSession(sender Sender, runner []string, log io.Writer) *Session {
	return &Session{sender: sender, runner: runner, log: log, running: make(map[string]chan string)}
}

// NewEvalSession builds a follow session that routes every exec.request into
// the persistent REPL session instead of spawning the runner per command.
func NewEvalSession(sender Sender, eval *execrun.EvalSession, log io.Writer) *Session {
	return &Session{
		sender: sender,
		// non-nil marker so Handle's exec-disabled refusal does not trigger;
		// commands never spawn through it while eval is set.
		runner:  []string{"eval"},
		eval:    eval,
		log:     log,
		running: make(map[string]chan string),
	}
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
		if len(s.runner) == 0 {
			_ = s.sender.SendJSON(protocol.ExecResponse{
				Type: protocol.TypeExecResponse, RequestID: req.RequestID, ExitCode: 127,
				Error: "exec disabled on this follower (started with no runner)",
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
		fmt.Fprintf(s.log, "exec: %s\n", req.Command)
	}
	var stdin []byte
	if req.Stdin != "" {
		decoded, err := base64.StdEncoding.DecodeString(req.Stdin)
		if err != nil {
			_ = s.sender.SendJSON(protocol.ExecResponse{
				Type: protocol.TypeExecResponse, RequestID: req.RequestID, ExitCode: 127,
				Error: "invalid exec.request stdin (expected base64)",
			})
			return
		}
		stdin = decoded
	}
	if s.eval != nil && len(stdin) > 0 {
		_ = s.sender.SendJSON(protocol.ExecResponse{
			Type: protocol.TypeExecResponse, RequestID: req.RequestID, ExitCode: 127,
			Error: "exec.request stdin is not supported in follow --eval mode (use per-command follow)",
		})
		return
	}
	ctrl := make(chan string, 4)
	s.mu.Lock()
	s.running[req.RequestID] = ctrl
	s.mu.Unlock()

	go func() {
		onChunk := func(stream string, data []byte) {
			_ = s.sender.SendJSON(protocol.ExecChunk{
				Type: protocol.TypeExecChunk, RequestID: req.RequestID, Stream: stream,
				Data: base64.StdEncoding.EncodeToString(data),
			})
		}
		var res execrun.Result
		if s.eval != nil {
			// Persistent REPL: req.Cwd/req.Env cannot apply to an already-running
			// process and are intentionally ignored.
			res = s.eval.Eval(ctx, req.Command, onChunk, ctrl)
		} else {
			res = execrun.Run(ctx, req.Command, execrun.Options{
				Runner:  s.runner,
				Cwd:     req.Cwd,
				Env:     req.Env,
				Stdin:   stdin,
				Control: ctrl,
				OnChunk: onChunk,
			})
		}
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
