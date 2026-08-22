// Package execrun runs a shell command on the local machine and streams its
// stdout/stderr as they arrive. It backs the `follow` subcommand: the leader's
// `exec.request` runs here, as the user who started `slicc … follow`.
package execrun

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
)

// chunkBytes bounds each streamed output block. Small enough that the tray data
// channel's backpressure stays responsive on chatty commands.
const chunkBytes = 16 * 1024

// ChunkFunc receives one streamed output block ("stdout"/"stderr", raw bytes).
type ChunkFunc func(stream string, data []byte)

// Options configures Run.
type Options struct {
	// Runner is the argv the command is handed to; the command string is appended
	// as the final argument. e.g. ["bash","-c"], ["sh","-c"],
	// ["docker","exec","-i","box","sh","-c"]. Required.
	Runner []string
	Cwd    string
	Env    map[string]string
	// Stdin is optional input written to the command before its stdin is closed.
	Stdin   []byte
	OnChunk ChunkFunc
	// Control forwards signal names ("SIGINT"/"SIGTERM"/"SIGKILL") to the running
	// process. Optional.
	Control <-chan string
}

// Result is the terminal outcome of a run.
type Result struct {
	ExitCode int
	// Signal is set (best-effort) when the process was terminated by a signal.
	Signal string
	// Err is set only when the command could not be started at all.
	Err error
}

// Run executes command via the platform shell, streams output through
// opts.OnChunk, and returns the exit code. It never returns an error for a
// non-zero exit — that's reported in Result.ExitCode; Result.Err is set only
// when the process could not be launched.
func Run(ctx context.Context, command string, opts Options) Result {
	if len(opts.Runner) == 0 {
		return Result{ExitCode: 126, Err: errors.New("no runner configured")}
	}
	argv := append(append([]string{}, opts.Runner...), command)
	cmd := exec.Command(argv[0], argv[1:]...)
	if opts.Cwd != "" {
		cmd.Dir = opts.Cwd
	}
	cmd.Env = mergedEnv(opts.Env)
	// Run the child in its own process group so a signal can reach the WHOLE
	// runner subtree (a shell may fork children — e.g. `sh -c` on some systems,
	// `docker exec`, pipelines — that would otherwise survive and keep the output
	// pipes open, hanging the read loop).
	setProcAttr(cmd)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{ExitCode: 126, Err: err}
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return Result{ExitCode: 126, Err: err}
	}
	var stdinPipe io.WriteCloser
	if len(opts.Stdin) > 0 {
		stdinPipe, err = cmd.StdinPipe()
		if err != nil {
			return Result{ExitCode: 126, Err: err}
		}
	}
	if err := cmd.Start(); err != nil {
		return Result{ExitCode: 127, Err: err}
	}
	if stdinPipe != nil {
		go func() {
			_, _ = stdinPipe.Write(opts.Stdin)
			_ = stdinPipe.Close()
		}()
	}

	finished := make(chan struct{})
	go forwardSignals(ctx, cmd, opts.Control, finished)

	var wg sync.WaitGroup
	wg.Add(2)
	go pump(stdout, "stdout", opts.OnChunk, &wg)
	go pump(stderr, "stderr", opts.OnChunk, &wg)
	wg.Wait()

	err = cmd.Wait()
	close(finished)

	if err == nil {
		return Result{ExitCode: 0}
	}
	var ee *exec.ExitError
	if errors.As(err, &ee) {
		code := ee.ExitCode()
		if code < 0 {
			// Terminated by a signal (Unix reports -1). Use a conventional code.
			return Result{ExitCode: 137, Signal: "killed"}
		}
		return Result{ExitCode: code}
	}
	return Result{ExitCode: 1, Err: err}
}

func pump(r io.Reader, stream string, onChunk ChunkFunc, wg *sync.WaitGroup) {
	defer wg.Done()
	buf := make([]byte, chunkBytes)
	for {
		n, err := r.Read(buf)
		if n > 0 && onChunk != nil {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])
			onChunk(stream, chunk)
		}
		if err != nil {
			return
		}
	}
}

func forwardSignals(ctx context.Context, cmd *exec.Cmd, control <-chan string, finished <-chan struct{}) {
	for {
		select {
		case <-finished:
			return
		case <-ctx.Done():
			killProcess(cmd, "SIGKILL")
			return
		case name, ok := <-control:
			if !ok {
				control = nil
				continue
			}
			killProcess(cmd, name)
		}
	}
}

func mergedEnv(extra map[string]string) []string {
	if len(extra) == 0 {
		return os.Environ()
	}
	env := os.Environ()
	for k, v := range extra {
		env = append(env, k+"="+v)
	}
	return env
}
