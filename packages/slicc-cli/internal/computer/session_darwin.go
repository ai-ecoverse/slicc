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



const (
	followFlag    = "--computer-follow"
	pairFlag      = "--pair"
	preflightFlag = "--computer-preflight"
	jsonFlag      = "--json"
)












const (
	readyLine    = "SLICC_COMPUTER_FOLLOW_READY"
	attachedLine = "SLICC_COMPUTER_FOLLOW_ATTACHED"
	failedPrefix = "SLICC_COMPUTER_FOLLOW_FAILED"
)

const (
	
	preflightTimeout = 2 * time.Minute
	
	
	stopGrace = 5 * time.Second
)






var (
	startTimeout  = 30 * time.Second
	attachTimeout = 60 * time.Second
)


var ErrOutdatedLauncher = errors.New(
	"the installed Sliccstart does not support " + followFlag +
		" — update Sliccstart (Sliccstart ▸ Check for Updates) and try again")



var ErrAttachFailed = errors.New("the Sliccstart launcher could not attach to the leader")

func attachError(reason string) error {
	return fmt.Errorf("%w: %s", ErrAttachFailed, reason)
}












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


type Session struct {
	opts Options

	
	
	
	retargetMu sync.Mutex

	mu      sync.Mutex
	joinURL string
	current *launcher
	stopped bool
}



type launcher struct {
	cancel      context.CancelFunc
	exited      chan struct{}
	intentional atomic.Bool
}




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

	
	
	runCtx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(runCtx, exe, args...)
	
	
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGTERM) }
	cmd.WaitDelay = stopGrace
	
	
	
	
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


func (w *launcherWatcher) failure() string {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.reason
}





func (w *launcherWatcher) awaitReady(exited <-chan struct{}) error {
	select {
	case <-w.ready:
		return nil
	case <-exited:
		
		
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
