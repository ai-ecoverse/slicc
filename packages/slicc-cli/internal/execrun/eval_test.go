package execrun

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"sync"
	"testing"
	"time"
)

// TestEvalHelperProcess is not a real test: it is the fake REPL the EvalSession
// tests spawn (the standard self-exec helper pattern, portable across the
// three CI OSes where no common REPL binary exists). It echoes each stdin line
// back as "echo:<line>", routes "stderr:<x>" lines to stderr, and exits with
// code 3 on "die".
func TestEvalHelperProcess(_ *testing.T) {
	if os.Getenv("SLICC_TEST_EVAL_REPL") == "" {
		return
	}
	// Real REPLs (python, clojure) catch SIGINT to abort the current
	// computation without dying; mirror that so the interrupt tests exercise
	// the keep-alive path.
	signal.Ignore(os.Interrupt)
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "die":
			os.Exit(3)
		case strings.HasPrefix(line, "stderr:"):
			fmt.Fprintf(os.Stderr, "err:%s\n", strings.TrimPrefix(line, "stderr:"))
		default:
			fmt.Printf("echo:%s\n", line)
		}
	}
	os.Exit(0)
}

func startTestEval(t *testing.T) *EvalSession {
	t.Helper()
	session, err := StartEval(EvalOptions{
		Runner: []string{os.Args[0], "-test.run=TestEvalHelperProcess"},
		Quiet:  150 * time.Millisecond,
		Env:    map[string]string{"SLICC_TEST_EVAL_REPL": "1"},
	})
	if err != nil {
		t.Fatalf("StartEval: %v", err)
	}
	t.Cleanup(session.Close)
	return session
}

// warmUpEval runs one round-trip so the helper REPL is provably past its
// startup (scanner loop running ⇒ its SIGINT-ignore handler is installed)
// before a test interrupts it.
func warmUpEval(t *testing.T, session *EvalSession) {
	t.Helper()
	log := &chunkLog{}
	if res := session.Eval(context.Background(), "warmup", log.add, nil); res.Err != nil {
		t.Fatalf("warmup Eval: %+v", res)
	}
	if !strings.Contains(log.joined(), "echo:warmup") {
		t.Fatalf("warmup output %q missing echo", log.joined())
	}
}

type chunkLog struct {
	mu     sync.Mutex
	chunks []string
}

func (c *chunkLog) add(stream string, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.chunks = append(c.chunks, stream+"|"+string(data))
}

func (c *chunkLog) joined() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return strings.Join(c.chunks, "")
}

func TestEvalPersistsAcrossCommands(t *testing.T) {
	session := startTestEval(t)

	first := &chunkLog{}
	res := session.Eval(context.Background(), "one", first.add, nil)
	if res.Err != nil || res.ExitCode != 0 {
		t.Fatalf("first Eval: %+v", res)
	}
	if !strings.Contains(first.joined(), "echo:one") {
		t.Fatalf("first output %q missing echo:one", first.joined())
	}

	// Same process answers the second command — the session did not respawn.
	second := &chunkLog{}
	res = session.Eval(context.Background(), "two\n", second.add, nil)
	if res.Err != nil || res.ExitCode != 0 {
		t.Fatalf("second Eval: %+v", res)
	}
	out := second.joined()
	if !strings.Contains(out, "echo:two") {
		t.Fatalf("second output %q missing echo:two", out)
	}
	// The trailing newline in the command must not produce an extra empty echo.
	if strings.Contains(out, "echo:\n") {
		t.Fatalf("second output %q contains an empty echo — newline was doubled", out)
	}
}

func TestEvalRoutesStderr(t *testing.T) {
	session := startTestEval(t)
	log := &chunkLog{}
	res := session.Eval(context.Background(), "stderr:boom", log.add, nil)
	if res.Err != nil {
		t.Fatalf("Eval: %+v", res)
	}
	if !strings.Contains(log.joined(), "stderr|err:boom") {
		t.Fatalf("output %q missing stderr-attributed chunk", log.joined())
	}
}

func TestEvalSerializesConcurrentCommands(t *testing.T) {
	session := startTestEval(t)
	var wg sync.WaitGroup
	logs := [2]*chunkLog{{}, {}}
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			res := session.Eval(context.Background(), fmt.Sprintf("cmd%d", n), logs[n].add, nil)
			if res.Err != nil {
				t.Errorf("Eval cmd%d: %+v", n, res)
			}
		}(i)
	}
	wg.Wait()
	// Each response must contain its own echo; ordering between the two is
	// unspecified, but output must not leak across responses.
	combined := logs[0].joined() + logs[1].joined()
	for _, want := range []string{"echo:cmd0", "echo:cmd1"} {
		if !strings.Contains(combined, want) {
			t.Fatalf("combined output %q missing %q", combined, want)
		}
	}
}

func TestEvalReportsReplDeath(t *testing.T) {
	session := startTestEval(t)
	res := session.Eval(context.Background(), "die", nil, nil)
	if res.Err == nil {
		t.Fatalf("want death error, got %+v", res)
	}
	if res.ExitCode != 3 {
		t.Fatalf("exit code = %d, want the REPL's 3", res.ExitCode)
	}

	// Subsequent commands refuse immediately with the same explanation.
	res = session.Eval(context.Background(), "after", nil, nil)
	if res.Err == nil || !strings.Contains(res.Err.Error(), "exited") {
		t.Fatalf("post-death Eval: %+v", res)
	}
}

func TestEvalHonorsContextCancellation(t *testing.T) {
	session := startTestEval(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	res := session.Eval(ctx, "anything", nil, nil)
	if time.Since(start) > 5*time.Second {
		t.Fatal("cancelled Eval did not return promptly")
	}
	if res.Err == nil {
		t.Fatalf("want an error after context cancellation, got %+v", res)
	}
}

func TestEvalSurvivesConnectionScopedCancel(t *testing.T) {
	// A dropped connection cancels the in-flight Eval's context; the shared
	// REPL must survive it so state persists across reconnects (the P1 from
	// review: SIGKILLing here handed a dead session to the next connection).
	session := startTestEval(t)
	warmUpEval(t, session)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if res := session.Eval(ctx, "during-drop", nil, nil); res.Err == nil {
		t.Fatalf("want an error for the cancelled eval, got %+v", res)
	}

	log := &chunkLog{}
	res := session.Eval(context.Background(), "after-reconnect", log.add, nil)
	if res.Err != nil || res.ExitCode != 0 {
		t.Fatalf("post-cancel Eval: %+v", res)
	}
	if !strings.Contains(log.joined(), "echo:after-reconnect") {
		t.Fatalf("output %q missing echo — the REPL did not survive the dropped connection", log.joined())
	}
}

func TestEvalSigintKeepsReplAlive(t *testing.T) {
	// Leader-sent SIGINT means "abort this computation", never "destroy the
	// session". The fake REPL ignores SIGINT like python/clojure do; on
	// Windows interruptProcess is a documented no-op — either way the session
	// must answer the next command.
	session := startTestEval(t)
	warmUpEval(t, session)
	control := make(chan string, 1)
	control <- "SIGINT"
	if res := session.Eval(context.Background(), "interrupted", nil, control); res.Err != nil {
		t.Fatalf("interrupted Eval: %+v", res)
	}

	log := &chunkLog{}
	res := session.Eval(context.Background(), "still-alive", log.add, nil)
	if res.Err != nil || res.ExitCode != 0 {
		t.Fatalf("post-SIGINT Eval: %+v", res)
	}
	if !strings.Contains(log.joined(), "echo:still-alive") {
		t.Fatalf("output %q missing echo — SIGINT killed the persistent REPL", log.joined())
	}
}

func TestStartEvalRequiresRunner(t *testing.T) {
	if _, err := StartEval(EvalOptions{}); err == nil {
		t.Fatal("want an error for an empty runner")
	}
}

func TestStartEvalMissingBinary(t *testing.T) {
	if _, err := StartEval(EvalOptions{Runner: []string{"slicc-no-such-repl-binary"}}); err == nil {
		t.Fatal("want an error for a missing REPL binary")
	}
}
