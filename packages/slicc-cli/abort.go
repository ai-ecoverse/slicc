package main

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/ai-ecoverse/slicc-cli/internal/protocol"
	"github.com/ai-ecoverse/slicc-cli/internal/tray"
)

func runAbortVerb(ctx context.Context, joinURL string, args []string) int {
	if len(args) == 1 && args[0] == "--help" {
		fmt.Println("slicc abort: usage: abort")
		return 0
	}
	if len(args) != 0 {
		fmt.Fprintln(os.Stderr, "slicc abort: usage: abort")
		return 2
	}
	return cmdAbort(ctx, joinURL)
}




func cmdAbort(ctx context.Context, joinURL string) int {
	acked := make(chan struct{}, 1)
	conn, err := tray.Dial(ctx, joinURL, tray.Options{
		OnMessage: func(typ string, _ []byte) {
			if typ == protocol.TypeAbortAck {
				select {
				case acked <- struct{}{}:
				default:
				}
			}
		},
		Logf: debugLogf, LogWanted: diagLogger.EnabledAt,
	})
	if err != nil {
		errLine("abort", "%s", err)
		return 1
	}
	defer conn.Close()
	if err := conn.SendJSON(protocol.Abort{Type: "abort"}); err != nil {
		errLine("abort", "could not tell the leader to stop: %s", err)
		return 1
	}
	timer := time.NewTimer(abortConfirmBound())
	defer timer.Stop()
	select {
	case <-acked:
		fmt.Println("stopped")
		return 0
	case <-conn.Done():
		errLine("abort", "the leader did not confirm the turn stopped")
		return 1
	case <-timer.C:
		errLine("abort", "the leader did not confirm the turn stopped")
		return 1
	case <-ctx.Done():
		return 130
	}
}
