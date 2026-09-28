package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/tray"
)

func runWaitVerb(ctx context.Context, joinURL string, args []string) int {
	if len(args) != 2 || args[0] != "--allsettled" {
		fmt.Fprintln(os.Stderr, "slicc wait: usage: wait --allsettled <duration>")
		return 2
	}
	quiet, err := time.ParseDuration(args[1])
	if err != nil || quiet <= 0 {
		fmt.Fprintln(os.Stderr, "slicc wait: --allsettled needs a positive duration, like 2m")
		return 2
	}
	return cmdWait(ctx, joinURL, quiet)
}

// cmdWait observes a running leader without adding a user message or aborting
// its work. The bench uses it when a completed prompt resumes during export.
func cmdWait(ctx context.Context, joinURL string, quiet time.Duration) int {
	all := newAllSettled(quiet, time.Now())
	all.turnEnded() // no prompted turn is required by this read-only verb
	kick := make(chan struct{}, 1)
	handler := func(typ string, raw []byte) {
		all.observe(typ, raw, time.Now())
		select {
		case kick <- struct{}{}:
		default:
		}
	}
	conn, err := tray.Dial(ctx, joinURL, tray.Options{
		OnMessage: handler, Logf: debugLogf, LogWanted: diagLogger.EnabledAt,
	})
	if err != nil {
		errLine("wait", "%s", err)
		return 1
	}
	defer conn.Close()
	all.touch(time.Now())

	timer := time.NewTimer(quiet)
	defer timer.Stop()
	for {
		if ok, remaining := all.settled(time.Now()); ok {
			fmt.Println("settled")
			return 0
		} else if remaining > 0 {
			timer.Stop()
			timer.Reset(remaining)
		}
		select {
		case <-ctx.Done():
			return 130
		case <-conn.Done():
			errLine("wait", "connection closed before the leader settled")
			return 1
		case <-kick:
		case <-timer.C:
		}
	}
}

// Touch after the follower is connected: dialing time is not idle time.
func (a *allSettled) touch(now time.Time) {
	a.mu.Lock()
	if now.After(a.last) {
		a.last = now
	}
	a.mu.Unlock()
}
