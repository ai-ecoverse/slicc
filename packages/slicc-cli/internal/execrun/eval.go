package execrun

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// DefaultEvalQuiet is the output-quiescence window that ends an Eval response.
// REPLs never signal "this result is complete", so a response is considered
// done once the REPL has been silent this long after the command was written.
const DefaultEvalQuiet = 500 * time.Millisecond

// EvalOptions configures StartEval.
type EvalOptions struct {
	// Runner is the REPL argv, spawned ONCE for the whole session
	// (e.g. ["python","-i"], ["node","-i"], ["clojure"]). Required.
	Runner []string
	// Quiet is the output-quiescence window ending each response
	// (DefaultEvalQuiet when zero).
	Quiet time.Duration
	// Env adds environment variables to the spawned REPL (tests).
	Env map[string]string
}

type evalEvent struct {
	stream string
	data   []byte
}

// EvalSession is a persistent REPL child process. Each Eval writes one command
// as a line to its stdin and replies with the output that follows — so state
// (variables, defs, imports) survives across commands, unlike Run, which
// spawns a fresh process per command. Eval calls are serialized: a REPL has
// one stdin, so concurrent leader commands queue.
type EvalSession struct {
	quiet time.Duration
	cmd   *exec.Cmd
	stdin io.WriteCloser
	// events carries merged stdout/stderr chunks; closed when both pumps end
	// (the REPL closed its output = it exited or is exiting).
	events chan evalEvent
	// exited is closed after cmd.Wait; exitResult then holds the outcome.
	exited     chan struct{}
	exitResult Result

	mu   sync.Mutex
	dead bool
}

// StartEval spawns the REPL and starts its output pumps. The returned session
// is ready for Eval calls; Close kills the REPL.
func StartEval(opts EvalOptions) (*EvalSession, error) {
	if len(opts.Runner) == 0 {
		return nil, errors.New("eval mode requires a runner (the REPL argv)")
	}
	quiet := opts.Quiet
	if quiet <= 0 {
		quiet = DefaultEvalQuiet
	}
	cmd := exec.Command(opts.Runner[0], opts.Runner[1:]...)
	cmd.Env = mergedEnv(opts.Env)
	setProcAttr(cmd)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	session := &EvalSession{
		quiet:  quiet,
		cmd:    cmd,
		stdin:  stdin,
		events: make(chan evalEvent, 64),
		exited: make(chan struct{}),
	}
	var wg sync.WaitGroup
	wg.Add(2)
	go session.pumpInto(stdout, "stdout", &wg)
	go session.pumpInto(stderr, "stderr", &wg)
	go func() {
		wg.Wait()
		close(session.events)
		session.exitResult = waitResult(cmd.Wait())
		close(session.exited)
	}()
	return session, nil
}

func (e *EvalSession) pumpInto(r io.Reader, stream string, wg *sync.WaitGroup) {
	defer wg.Done()
	buf := make([]byte, chunkBytes)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			e.events <- evalEvent{stream: stream, data: chunk}
		}
		if err != nil {
			return
		}
	}
}

// waitResult maps a cmd.Wait error to the same Result shape Run produces.
func waitResult(err error) Result {
	if err == nil {
		return Result{ExitCode: 0}
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		if code := ee.ExitCode(); code >= 0 {
			return Result{ExitCode: code}
		}
		return Result{ExitCode: 137, Signal: "killed"}
	}
	return Result{ExitCode: 1, Err: err}
}

// Eval writes command as one line to the REPL's stdin and streams the output
// that follows through onChunk. The response ends after the quiescence window;
// exit code 0 means "the REPL is still alive", not per-command success — REPLs
// report errors in their output, not via exit codes. control forwards signal
// names to the REPL process (SIGINT interrupts most REPLs' current
// computation without killing them). Calls are serialized.
func (e *EvalSession) Eval(
	ctx context.Context,
	command string,
	onChunk ChunkFunc,
	control <-chan string,
) Result {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.dead {
		return e.deadResult()
	}
	// Output that arrived between commands (late output of the previous
	// command, or the prompt the REPL printed while idle) is forwarded at the
	// head of this response rather than silently dropped.
	e.drainPending(onChunk)

	if !strings.HasSuffix(command, "\n") {
		command += "\n"
	}
	if _, err := io.WriteString(e.stdin, command); err != nil {
		// A failed stdin write means the REPL is gone (EPIPE); finishDead
		// synchronizes on cmd.Wait before reading the exit result.
		return e.finishDead()
	}
	return e.collect(ctx, onChunk, control)
}

// collect forwards output events until the quiescence window elapses, the REPL
// exits, the context ends, or a kill signal arrives.
func (e *EvalSession) collect(ctx context.Context, onChunk ChunkFunc, control <-chan string) Result {
	timer := time.NewTimer(e.quiet)
	defer timer.Stop()
	for {
		select {
		case event, ok := <-e.events:
			if !ok {
				return e.finishDead()
			}
			if onChunk != nil {
				onChunk(event.stream, event.data)
			}
			if !timer.Stop() {
				<-timer.C
			}
			timer.Reset(e.quiet)
		case <-timer.C:
			return Result{ExitCode: 0}
		case <-ctx.Done():
			killProcess(e.cmd, "SIGKILL")
			return e.finishDead()
		case name, ok := <-control:
			if !ok {
				control = nil
				continue
			}
			killProcess(e.cmd, name)
		}
	}
}

// drainPending forwards already-buffered output without blocking.
func (e *EvalSession) drainPending(onChunk ChunkFunc) {
	for {
		select {
		case event, ok := <-e.events:
			if !ok {
				return
			}
			if onChunk != nil {
				onChunk(event.stream, event.data)
			}
		default:
			return
		}
	}
}

// finishDead waits for the exit result, marks the session dead, and reports it.
func (e *EvalSession) finishDead() Result {
	<-e.exited
	e.dead = true
	return e.deadResult()
}

func (e *EvalSession) deadResult() Result {
	res := e.exitResult
	if res.Err == nil {
		res.Err = fmt.Errorf("the REPL process exited (code %d) — restart slicc follow to get a fresh session", res.ExitCode)
	}
	if res.ExitCode == 0 {
		res.ExitCode = 1
	}
	return res
}

// Close kills the REPL process. Safe to call once Eval callers are done.
func (e *EvalSession) Close() {
	killProcess(e.cmd, "SIGKILL")
	_ = e.stdin.Close()
}
