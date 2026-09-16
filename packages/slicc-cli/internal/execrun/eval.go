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

const DefaultEvalQuiet = 500 * time.Millisecond

type EvalOptions struct {
	Runner []string

	Quiet time.Duration

	Env map[string]string
}

type evalEvent struct {
	stream string
	data   []byte
}

type EvalSession struct {
	quiet time.Duration
	cmd   *exec.Cmd
	stdin io.WriteCloser

	events chan evalEvent

	exited     chan struct{}
	exitResult Result

	mu   sync.Mutex
	dead bool
}

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

	e.drainPending(onChunk)

	if !strings.HasSuffix(command, "\n") {
		command += "\n"
	}
	if _, err := io.WriteString(e.stdin, command); err != nil {

		return e.finishDead()
	}
	return e.collect(ctx, onChunk, control)
}

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

			interruptProcess(e.cmd)
			return Result{ExitCode: 130, Signal: "interrupted", Err: ctx.Err()}
		case name, ok := <-control:
			if !ok {
				control = nil
				continue
			}
			if name == "SIGINT" {

				interruptProcess(e.cmd)
				continue
			}
			killProcess(e.cmd, name)
		}
	}
}

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

func (e *EvalSession) Close() {
	killProcess(e.cmd, "SIGKILL")
	_ = e.stdin.Close()
}
