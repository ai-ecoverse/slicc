//go:build darwin

package computer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/cloud"
)

// Flags the headless launcher modes are spelled with. Mirrored in
// packages/swift-launcher/Sliccstart/Models/ComputerFollowCLI.swift.
const (
	followFlag    = "--computer-follow"
	pairFlag      = "--pair"
	preflightFlag = "--computer-preflight"
	jsonFlag      = "--json"
)

// readyLine is the first line `--computer-follow` prints on stdout. It is the
// only way to tell a launcher that understands the flag from one that does not:
// an older Sliccstart ignores unknown arguments and boots its GUI, which never
// exits and would otherwise look like a healthy follower forever.
const readyLine = "SLICC_COMPUTER_FOLLOW_READY"

const (
	// preflightTimeout has to outlast a human deciding on two TCC dialogs.
	preflightTimeout = 2 * time.Minute
	// stopGrace is how long a SIGTERM'd launcher has to withdraw from the
	// leader before it is killed outright.
	stopGrace = 5 * time.Second
)

// startTimeout bounds the wait for readyLine. Generous because the launcher may
// be cold — this is not the capture path, and overshooting only delays the
// "update Sliccstart" diagnosis. A var so the test for the hang case (an older
// launcher booting its GUI instead of answering) does not take half a minute.
var startTimeout = 30 * time.Second

// ErrOutdatedLauncher means the Sliccstart on this Mac predates #3260.
var ErrOutdatedLauncher = errors.New(
	"the installed Sliccstart does not support " + followFlag +
		" — update Sliccstart (Sliccstart ▸ Check for Updates) and try again")

// Preflight raises the Screen Recording and Accessibility prompts through the
// signed launcher and reports what is granted afterwards.
//
// Called once at `follow --computer` startup, while the human is still looking
// at the terminal. Without it the first prompt lands mid-turn, on whichever
// `computer screenshot` the agent happened to run, and the turn stalls on a
// dialog nobody is watching.
//
// A launcher that answers "not granted" is not an error — the grant state IS
// the answer, and the caller decides what to do with it. Only failing to ask
// at all is.
func Preflight(ctx context.Context) (Grants, error) {
	exe, err := cloud.LocateExecutable()
	if err != nil {
		return Grants{}, err
	}
	runCtx, cancel := context.WithTimeout(ctx, preflightTimeout)
	defer cancel()

	cmd := exec.CommandContext(runCtx, exe, preflightFlag, jsonFlag)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	runErr := cmd.Run()

	var grants Grants
	if err := json.Unmarshal(bytes.TrimSpace(stdout.Bytes()), &grants); err == nil {
		return grants, nil
	}
	if runCtx.Err() != nil {
		// No JSON and a dead clock: an older launcher booted its GUI instead of
		// answering, exactly as the --list-sessions path already guards against.
		return Grants{}, ErrOutdatedLauncher
	}
	if msg := strings.TrimSpace(stderr.String()); msg != "" {
		return Grants{}, fmt.Errorf("%s", msg)
	}
	if runErr != nil {
		return Grants{}, fmt.Errorf("running Sliccstart %s: %w", preflightFlag, runErr)
	}
	return Grants{}, ErrOutdatedLauncher
}

// Session is a headless Sliccstart following the same leader as this CLI.
type Session struct {
	opts Options

	mu      sync.Mutex
	joinURL string
	stop    context.CancelFunc
	exited  chan struct{}
	stopped bool
}

// Start locates Sliccstart and brings up its headless computer follower,
// returning once the launcher has confirmed it understands the mode.
func Start(ctx context.Context, opts Options) (*Session, error) {
	if opts.JoinURL == "" {
		return nil, errors.New("computer follower needs a join URL")
	}
	s := &Session{opts: opts, joinURL: opts.JoinURL}
	if err := s.spawn(ctx, opts.JoinURL); err != nil {
		return nil, err
	}
	return s, nil
}

// Retarget moves the launcher to a replacement leader. The CLI calls it when a
// tray is superseded (`TRAY_SUPERSEDED` / a `successor-version` hop): the
// launcher holds the *old* join URL, so leaving it alone would keep one half of
// the pair on a tray that no longer exists.
func (s *Session) Retarget(ctx context.Context, joinURL string) error {
	if joinURL == "" {
		return nil
	}
	s.mu.Lock()
	if s.stopped || joinURL == s.joinURL {
		s.mu.Unlock()
		return nil
	}
	s.joinURL = joinURL
	s.mu.Unlock()

	s.terminate()
	return s.spawn(ctx, joinURL)
}

// Stop terminates the launcher and waits for it to go, so quitting the CLI does
// not leave a headless Sliccstart attached to the leader.
func (s *Session) Stop() {
	s.mu.Lock()
	if s.stopped {
		s.mu.Unlock()
		return
	}
	s.stopped = true
	s.mu.Unlock()
	s.terminate()
}

func (s *Session) spawn(ctx context.Context, joinURL string) error {
	exe, err := cloud.LocateExecutable()
	if err != nil {
		return err
	}
	args := []string{followFlag, joinURL}
	if s.opts.PairID != "" {
		args = append(args, pairFlag, s.opts.PairID)
	}

	// Its own cancel function, not the caller's ctx alone: Retarget has to be
	// able to kill one launcher and start the next without ending the session.
	runCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(runCtx, exe, args...)
	// SIGTERM first so the launcher can withdraw from the leader; CommandContext
	// escalates to SIGKILL after WaitDelay if it does not.
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = stopGrace
	// A line-scanning writer rather than StdoutPipe: os/exec closes a pipe as
	// soon as Wait sees the process exit, so a reader racing Wait can lose the
	// very last lines — including the one that says the launcher is healthy.
	// Handed to cmd.Stdout, the copy is part of what Wait waits for.
	watcher := newReadyWatcher(s.logf)
	cmd.Stdout = watcher
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("starting Sliccstart %s: %w", followFlag, err)
	}

	exited := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(exited)
	}()

	if err := watcher.await(exited); err != nil {
		cancel()
		<-exited
		if msg := strings.TrimSpace(stderr.String()); msg != "" && errors.Is(err, ErrOutdatedLauncher) {
			return fmt.Errorf("%w (Sliccstart said: %s)", err, msg)
		}
		return err
	}

	s.mu.Lock()
	s.stop, s.exited = cancel, exited
	s.mu.Unlock()
	return nil
}

// readyWatcher is the launcher's stdout: it splits the stream into lines, logs
// each one, and closes `ready` when readyLine arrives.
//
// It keeps consuming afterwards rather than detaching, so a chatty launcher can
// never fill the OS pipe buffer and wedge itself mid-session.
type readyWatcher struct {
	logf    func(string, ...any)
	ready   chan struct{}
	once    sync.Once
	partial []byte
}

func newReadyWatcher(logf func(string, ...any)) *readyWatcher {
	return &readyWatcher{logf: logf, ready: make(chan struct{})}
}

func (w *readyWatcher) Write(p []byte) (int, error) {
	w.partial = append(w.partial, p...)
	for {
		nl := bytes.IndexByte(w.partial, '\n')
		if nl < 0 {
			break
		}
		line := strings.TrimSpace(string(w.partial[:nl]))
		w.partial = w.partial[nl+1:]
		if line == "" {
			continue
		}
		w.logf("sliccstart: %s", line)
		if line == readyLine {
			w.once.Do(func() { close(w.ready) })
		}
	}
	return len(p), nil
}

// await blocks until the launcher reports ready, dies, or runs out of patience.
// Every failure is the same diagnosis: a launcher that understands the flag
// says so immediately, so anything else is one that does not (an older build
// ignores unknown arguments and boots its GUI, which never exits).
func (w *readyWatcher) await(exited <-chan struct{}) error {
	select {
	case <-w.ready:
		return nil
	case <-exited:
		// Wait has returned, so the stdout copy is finished — if readyLine was
		// in the final write, it is already visible here.
		select {
		case <-w.ready:
			return nil
		default:
			return ErrOutdatedLauncher
		}
	case <-time.After(startTimeout):
		return ErrOutdatedLauncher
	}
}

func (s *Session) terminate() {
	s.mu.Lock()
	stop, exited := s.stop, s.exited
	s.stop, s.exited = nil, nil
	s.mu.Unlock()
	if stop == nil {
		return
	}
	stop()
	if exited != nil {
		<-exited
	}
}

func (s *Session) logf(format string, args ...any) {
	if s.opts.Logf != nil {
		s.opts.Logf(format, args...)
	}
}
