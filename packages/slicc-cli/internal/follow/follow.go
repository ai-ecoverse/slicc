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

type Sender interface {
	SendJSON(v any) error
}

type Session struct {
	sender Sender

	runner []string

	eval *execrun.EvalSession

	log io.Writer

	mu      sync.Mutex
	running map[string]chan string
}

func NewSession(sender Sender, runner []string, log io.Writer) *Session {
	return &Session{sender: sender, runner: runner, log: log, running: make(map[string]chan string)}
}

func NewEvalSession(sender Sender, eval *execrun.EvalSession, log io.Writer) *Session {
	return &Session{
		sender: sender,

		runner:  []string{"eval"},
		eval:    eval,
		log:     log,
		running: make(map[string]chan string),
	}
}

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
