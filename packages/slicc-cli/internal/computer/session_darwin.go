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
	"sync/atomic"
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

// The launcher's stdout protocol, mirrored in
// packages/swift-launcher/Sliccstart/Models/ComputerFollowCLI.swift.
//
// Two separate facts, on purpose. readyLine is printed at once and only means
// "this build understands --computer-follow" — the one way to tell it from an
// older Sliccstart, which ignores unknown arguments and boots its GUI (never
// exiting, so it would pass for a healthy child forever). attachedLine means the
// leader can now actually reach the screen. Folding the two together would
// either report an unreachable leader as an outdated launcher, or — as the first
// version of this did — report a launcher as healthy before it ever attached,
// letting --computer=require continue without a screen.
const (
	readyLine    = "SLICC_COMPUTER_FOLLOW_READY"
	attachedLine = "SLICC_COMPUTER_FOLLOW_ATTACHED"
	failedPrefix = "SLICC_COMPUTER_FOLLOW_FAILED"
)

const (
	// preflightTimeout has to outlast a human deciding on two TCC dialogs.
	preflightTimeout = 2 * time.Minute
	// stopGrace is how long a SIGTERM'd launcher has to withdraw from the
	// leader before it is killed outright.
	stopGrace = 5 * time.Second
)

// startTimeout bounds the wait for readyLine. Generous because the launcher may
// be cold — this is not the capture path, and overshooting only delays the
// "update Sliccstart" diagnosis. attachTimeout bounds the wait after it for the
// WebRTC attach, which can take a TURN relay's worth of round trips. Vars so the
// tests for the hang cases do not take a minute each.
var (
	startTimeout  = 30 * time.Second
	attachTimeout = 60 * time.Second
)

// ErrOutdatedLauncher means the Sliccstart on this Mac predates #3260.
var ErrOutdatedLauncher = errors.New(
	"the installed Sliccstart does not support " + followFlag +
		" — update Sliccstart (Sliccstart ▸ Check for Updates) and try again")

// ErrAttachFailed means the launcher understood the request but could not reach
// the leader. It wraps the launcher's own reason.
var ErrAttachFailed = errors.New("the Sliccstart launcher could not attach to the leader")

func attachError(reason string) error {
	return fmt.Errorf("%w: %s", ErrAttachFailed, reason)
}

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

	// retargetMu serialises Retarget calls end to end. Its terminate+spawn pair
	// is not atomic under mu, and two supersede hops arriving back to back must
	// not leave two launchers running.
	retargetMu sync.Mutex

	mu      sync.Mutex
	joinURL string
	current *launcher
	stopped bool
}

// launcher is one spawned process. intentional marks an exit this side asked
// for, so the watcher does not report a Stop or a Retarget as a crash.
type launcher struct {
	cancel      context.CancelFunc
	exited      chan struct{}
	intentional atomic.Bool
}

// Start locates Sliccstart and brings up its headless computer follower,
// returning once the launcher reports it has attached to the leader — not
// merely started — so the caller only calls the screen present when it is.
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
//
// It blocks for as long as the new launcher takes to attach, so callers on a
// connection path should run it in the background.
func (s *Session) Retarget(ctx context.Context, joinURL string) error {
	if joinURL == "" {
		return nil
	}
	s.retargetMu.Lock()
	defer s.retargetMu.Unlock()

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
	// very last lines — including the one that says why the launcher gave up.
	// Handed to cmd.Stdout, the copy is part of what Wait waits for.
	watcher := newLauncherWatcher(s.logf)
	cmd.Stdout = watcher
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		cancel()
		return fmt.Errorf("starting Sliccstart %s: %w", followFlag, err)
	}

	l := &launcher{cancel: cancel, exited: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		close(l.exited)
	}()

	err = watcher.awaitReady(l.exited)
	if err == nil {
		err = watcher.awaitAttached(l.exited)
	}
	if err != nil {
		l.intentional.Store(true)
		cancel()
		<-l.exited
		if msg := strings.TrimSpace(stderr.String()); msg != "" {
			return fmt.Errorf("%w (Sliccstart said: %s)", err, msg)
		}
		return err
	}

	go s.watchExit(l, watcher)

	s.mu.Lock()
	if s.stopped {
		// Stop ran while this launcher was still attaching and found nothing
		// to terminate. Keeping it would leave a follower nobody reaps.
		s.mu.Unlock()
		l.intentional.Store(true)
		cancel()
		<-l.exited
		return nil
	}
	s.current = l
	s.mu.Unlock()
	return nil
}

// watchExit reports a launcher that went away on its own after attaching — it
// gave up reconnecting, or crashed. The CLI keeps following as an exec target,
// so without this the screen would vanish from the session in silence.
func (s *Session) watchExit(l *launcher, w *launcherWatcher) {
	<-l.exited
	if l.intentional.Load() || s.opts.OnExit == nil {
		return
	}
	reason := w.failure()
	if reason == "" {
		reason = "Sliccstart exited"
	}
	s.opts.OnExit(reason)
}

// launcherWatcher is the launcher's stdout: it splits the stream into lines,
// logs each one, and records the protocol lines as they arrive.
//
// It keeps consuming for the process's whole life rather than detaching, so a
// chatty launcher can never fill the OS pipe buffer and wedge itself.
type launcherWatcher struct {
	logf func(string, ...any)

	ready, attached, failed chan struct{}
	readyOnce               sync.Once
	attachedOnce            sync.Once
	failedOnce              sync.Once

	mu      sync.Mutex
	reason  string
	partial []byte
}

func newLauncherWatcher(logf func(string, ...any)) *launcherWatcher {
	return &launcherWatcher{
		logf:     logf,
		ready:    make(chan struct{}),
		attached: make(chan struct{}),
		failed:   make(chan struct{}),
	}
}

func (w *launcherWatcher) Write(p []byte) (int, error) {
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
		switch {
		case line == readyLine:
			w.readyOnce.Do(func() { close(w.ready) })
		case line == attachedLine:
			w.attachedOnce.Do(func() { close(w.attached) })
		case line == failedPrefix || strings.HasPrefix(line, failedPrefix+" "):
			w.mu.Lock()
			w.reason = strings.TrimSpace(strings.TrimPrefix(line, failedPrefix))
			w.mu.Unlock()
			w.failedOnce.Do(func() { close(w.failed) })
		}
	}
	return len(p), nil
}

// failure is the reason the launcher gave on its FAILED line, if any.
func (w *launcherWatcher) failure() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.reason
}

// awaitReady blocks until the launcher says it understands the flag. Every
// failure here is the same diagnosis: a build that knows the flag says so before
// doing anything else, so silence, an early exit or a timeout all mean one that
// does not.
func (w *launcherWatcher) awaitReady(exited <-chan struct{}) error {
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

// awaitAttached blocks until the launcher has reached the leader. Past
// awaitReady the build is known to be current, so every failure now is about
// the connection, and the launcher's own reason is the best explanation.
func (w *launcherWatcher) awaitAttached(exited <-chan struct{}) error {
	select {
	case <-w.attached:
		return nil
	case <-w.failed:
		return attachError(w.failureOr("no reason given"))
	case <-exited:
		select {
		case <-w.attached:
			return nil
		default:
			return attachError(w.failureOr("Sliccstart exited before attaching"))
		}
	case <-time.After(attachTimeout):
		return attachError(fmt.Sprintf("no connection to the leader after %s", attachTimeout))
	}
}

func (w *launcherWatcher) failureOr(fallback string) string {
	if reason := w.failure(); reason != "" {
		return reason
	}
	return fallback
}

func (s *Session) terminate() {
	s.mu.Lock()
	l := s.current
	s.current = nil
	s.mu.Unlock()
	if l == nil {
		return
	}
	l.intentional.Store(true)
	l.cancel()
	<-l.exited
}

func (s *Session) logf(format string, args ...any) {
	if s.opts.Logf != nil {
		s.opts.Logf(format, args...)
	}
}
