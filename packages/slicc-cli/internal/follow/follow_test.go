package follow

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/execrun"
	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
)

// testRunner is the platform shell the exec tests hand commands to, so the
// always-run tests exercise the Windows (`cmd /c`) path instead of skipping.
func testRunner() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd", "/c"}
	}
	return []string{"sh", "-c"}
}

type fakeSender struct {
	mu   sync.Mutex
	msgs []map[string]any
	resp chan map[string]any
}

func newFakeSender() *fakeSender {
	return &fakeSender{resp: make(chan map[string]any, 1)}
}

func (f *fakeSender) SendJSON(v any) error {
	b, _ := json.Marshal(v)
	var m map[string]any
	_ = json.Unmarshal(b, &m)
	f.mu.Lock()
	f.msgs = append(f.msgs, m)
	f.mu.Unlock()
	if m["type"] == "exec.response" {
		select {
		case f.resp <- m:
		default:
		}
	}
	return nil
}

func (f *fakeSender) chunks(stream string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := ""
	for _, m := range f.msgs {
		if m["type"] == "exec.chunk" && m["stream"] == stream {
			if data, ok := m["data"].(string); ok {
				b, _ := base64.StdEncoding.DecodeString(data)
				out += string(b)
			}
		}
	}
	return out
}

func waitResponse(t *testing.T, f *fakeSender) map[string]any {
	t.Helper()
	select {
	case m := <-f.resp:
		return m
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for exec.response")
		return nil
	}
}

func TestSessionForwardsStdin(t *testing.T) {
	sender := newFakeSender()
	s := NewSession(sender, testRunner(), nil)
	s.Handle(context.Background(), protocol.TypeExecRequest, mustJSON(protocol.ExecRequest{
		Type: "exec.request", RequestID: "r1", Command: "cat",
		Stdin: base64.StdEncoding.EncodeToString([]byte("piped\n")),
	}))
	resp := waitResponse(t, sender)
	if resp["exitCode"] != float64(0) {
		t.Fatalf("exitCode = %v, want 0", resp["exitCode"])
	}
	if got := sender.chunks("stdout"); got != "piped\n" {
		t.Fatalf("stdout = %q, want piped\\n", got)
	}
}

func TestSessionRunsCommandAndStreams(t *testing.T) {
	sender := newFakeSender()
	s := NewSession(sender, testRunner(), nil)
	s.Handle(context.Background(), protocol.TypeExecRequest, mustJSON(protocol.ExecRequest{
		Type: "exec.request", RequestID: "r1", Command: "echo hello-follow",
	}))
	resp := waitResponse(t, sender)
	if resp["exitCode"] != float64(0) {
		t.Fatalf("exitCode = %v, want 0", resp["exitCode"])
	}
	if got := sender.chunks("stdout"); got != "hello-follow\n" && got != "hello-follow\r\n" {
		t.Fatalf("stdout = %q, want hello-follow", got)
	}
}

func TestSessionNoRunnerRefuses(t *testing.T) {
	sender := newFakeSender()
	s := NewSession(sender, nil, nil)
	s.Handle(context.Background(), protocol.TypeExecRequest, mustJSON(protocol.ExecRequest{
		Type: "exec.request", RequestID: "r1", Command: "echo nope",
	}))
	resp := waitResponse(t, sender)
	if resp["exitCode"] != float64(127) {
		t.Fatalf("exitCode = %v, want 127", resp["exitCode"])
	}
	if resp["error"] == nil {
		t.Fatal("expected an error on a denied exec")
	}
}

func TestSessionSignalAborts(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sleep + POSIX signals unavailable on cmd.exe")
	}
	sender := newFakeSender()
	s := NewSession(sender, []string{"sh", "-c"}, nil)
	s.Handle(context.Background(), protocol.TypeExecRequest, mustJSON(protocol.ExecRequest{
		Type: "exec.request", RequestID: "r1", Command: "sleep 30",
	}))
	time.Sleep(100 * time.Millisecond)
	s.Handle(context.Background(), protocol.TypeExecSignal, mustJSON(protocol.ExecSignal{
		Type: "exec.signal", RequestID: "r1", Signal: "SIGKILL",
	}))
	resp := waitResponse(t, sender)
	if resp["exitCode"] == float64(0) {
		t.Fatal("expected non-zero exit after signal")
	}
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// startTestEvalSession spawns the execrun test-helper fake REPL (see
// TestEvalHelperProcess in internal/execrun) for eval-mode session tests.
func startTestEvalSession(t *testing.T) *execrun.EvalSession {
	t.Helper()
	eval, err := execrun.StartEval(execrun.EvalOptions{
		Runner: []string{os.Args[0], "-test.run=TestFollowEvalHelperProcess"},
		Quiet:  150 * time.Millisecond,
		Env:    map[string]string{"SLICC_TEST_EVAL_REPL": "1"},
	})
	if err != nil {
		t.Fatalf("StartEval: %v", err)
	}
	t.Cleanup(eval.Close)
	return eval
}

// TestFollowEvalHelperProcess is the fake REPL for this package's eval tests
// (line-echo loop; see the execrun twin for the pattern).
func TestFollowEvalHelperProcess(_ *testing.T) {
	if os.Getenv("SLICC_TEST_EVAL_REPL") == "" {
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		fmt.Printf("echo:%s\n", scanner.Text())
	}
	os.Exit(0)
}

func TestEvalSessionRejectsStdin(t *testing.T) {
	sender := newFakeSender()
	session := NewEvalSession(sender, startTestEvalSession(t), nil)

	session.Handle(context.Background(), protocol.TypeExecRequest,
		mustJSON(protocol.ExecRequest{
			Type: protocol.TypeExecRequest, RequestID: "r1", Command: "cat",
			Stdin: base64.StdEncoding.EncodeToString([]byte("piped\n")),
		}))
	resp := waitResponse(t, sender)
	if resp["exitCode"] != float64(127) {
		t.Fatalf("exitCode = %v, want 127", resp["exitCode"])
	}
	if resp["error"] == nil {
		t.Fatal("expected an error when stdin is sent to eval mode")
	}
}

func TestEvalSessionAnswersSequentialRequestsFromOneRepl(t *testing.T) {
	sender := newFakeSender()
	session := NewEvalSession(sender, startTestEvalSession(t), nil)

	session.Handle(context.Background(), protocol.TypeExecRequest,
		mustJSON(protocol.ExecRequest{Type: protocol.TypeExecRequest, RequestID: "r1", Command: "alpha"}))
	resp := waitResponse(t, sender)
	if resp["requestId"] != "r1" || resp["exitCode"] != float64(0) {
		t.Fatalf("first response = %v", resp)
	}

	session.Handle(context.Background(), protocol.TypeExecRequest,
		mustJSON(protocol.ExecRequest{Type: protocol.TypeExecRequest, RequestID: "r2", Command: "beta"}))
	resp = waitResponse(t, sender)
	if resp["requestId"] != "r2" || resp["exitCode"] != float64(0) {
		t.Fatalf("second response = %v", resp)
	}

	out := sender.chunks("stdout")
	if !strings.Contains(out, "echo:alpha") || !strings.Contains(out, "echo:beta") {
		t.Fatalf("streamed output %q missing echoes from the persistent REPL", out)
	}
}
