package execrun

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"sync"
)

const chunkBytes = 16 * 1024

type ChunkFunc func(stream string, data []byte)

type Options struct {
	Runner []string
	Cwd    string
	Env    map[string]string

	Stdin   []byte
	OnChunk ChunkFunc

	Control <-chan string
}

type Result struct {
	ExitCode int

	Signal string

	Err error
}

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
