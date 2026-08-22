package execrun

import (
	"context"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// testRunner is the platform shell (`echo`/`exit` work under both), so the
// always-run tests exercise the Windows (`cmd /c`) path instead of skipping.
func testRunner() []string {
	if runtime.GOOS == "windows" {
		return []string{"cmd", "/c"}
	}
	return []string{"sh", "-c"}
}

type capture struct {
	mu     sync.Mutex
	stdout strings.Builder
	stderr strings.Builder
}

func (c *capture) onChunk(stream string, data []byte) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if stream == "stderr" {
		c.stderr.Write(data)
	} else {
		c.stdout.Write(data)
	}
}

func (c *capture) out() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stdout.String()
}

func (c *capture) err() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.stderr.String()
}

func TestRunStdin(t *testing.T) {
	c := &capture{}
	res := Run(context.Background(), "cat", Options{
		Runner: testRunner(), OnChunk: c.onChunk, Stdin: []byte("piped\n"),
	})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0 (err=%v)", res.ExitCode, res.Err)
	}
	if c.out() != "piped\n" {
		t.Fatalf("stdout = %q, want %q", c.out(), "piped\n")
	}
}

func TestRunStdoutAndExitZero(t *testing.T) {
	c := &capture{}
	res := Run(context.Background(), "echo hello-follower", Options{Runner: testRunner(), OnChunk: c.onChunk})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0 (err=%v)", res.ExitCode, res.Err)
	}
	if !strings.Contains(c.out(), "hello-follower") {
		t.Fatalf("stdout = %q, want to contain hello-follower", c.out())
	}
}

func TestRunNonZeroExit(t *testing.T) {
	c := &capture{}
	res := Run(context.Background(), "exit 3", Options{Runner: testRunner(), OnChunk: c.onChunk})
	if res.ExitCode != 3 {
		t.Fatalf("exit = %d, want 3", res.ExitCode)
	}
}

func TestRunStderr(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("redirection form differs on cmd.exe")
	}
	c := &capture{}
	res := Run(context.Background(), "echo oops 1>&2", Options{Runner: []string{"sh", "-c"}, OnChunk: c.onChunk})
	if res.ExitCode != 0 {
		t.Fatalf("exit = %d, want 0", res.ExitCode)
	}
	if !strings.Contains(c.err(), "oops") {
		t.Fatalf("stderr = %q, want to contain oops", c.err())
	}
}

func TestRunSignalTerminates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sleep + POSIX signals not available on cmd.exe")
	}
	control := make(chan string, 1)
	done := make(chan Result, 1)
	go func() {
		done <- Run(context.Background(), "sleep 30", Options{Runner: []string{"sh", "-c"}, Control: control})
	}()
	// Give the process a moment to start, then interrupt it.
	time.Sleep(100 * time.Millisecond)
	control <- "SIGKILL"

	select {
	case res := <-done:
		if res.ExitCode == 0 {
			t.Fatalf("expected non-zero exit after signal, got 0")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("command did not terminate after signal")
	}
}

func TestRunContextCancelTerminates(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sleep not available on cmd.exe")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan Result, 1)
	go func() {
		done <- Run(ctx, "sleep 30", Options{Runner: []string{"sh", "-c"}})
	}()
	time.Sleep(100 * time.Millisecond)
	cancel()

	select {
	case res := <-done:
		if res.ExitCode == 0 {
			t.Fatalf("expected non-zero exit after cancel, got 0")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("command did not terminate after context cancel")
	}
}
