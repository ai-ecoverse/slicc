// Command slicc is a headless SLICC follower CLI. It joins a leader session over
// WebRTC and offers three verbs:
//
//	slicc <join-url> prompt "text"   stream one assistant turn, then exit
//	slicc <join-url> exec "command"  run a command in the leader's shell, stream output
//	slicc <join-url> follow          stay connected; run leader-issued commands locally
//
// In `follow` the leader can run shell commands on this machine, as the user who
// started the process (see the startup banner). Pass --deny-exec to refuse.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// version is stamped at build time via -ldflags "-X main.version=…".
var version = "dev"

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		usage(os.Stderr)
		return 2
	}
	switch args[0] {
	case "-h", "--help", "help":
		usage(os.Stdout)
		return 0
	case "-v", "--version", "version":
		fmt.Println("slicc", version)
		return 0
	}

	joinURL := args[0]
	if !strings.HasPrefix(joinURL, "http://") && !strings.HasPrefix(joinURL, "https://") {
		fmt.Fprintf(os.Stderr, "slicc: first argument must be a join URL (https://…/join/<token>), got %q\n", joinURL)
		return 2
	}
	if len(args) < 2 {
		fmt.Fprintln(os.Stderr, "slicc: missing subcommand (prompt | exec | follow)")
		usage(os.Stderr)
		return 2
	}
	sub := args[1]
	rest := args[2:]

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	switch sub {
	case "prompt":
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "slicc prompt: missing prompt text")
			return 2
		}
		return cmdPrompt(ctx, joinURL, strings.Join(rest, " "))
	case "exec":
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "slicc exec: missing command")
			return 2
		}
		return cmdExec(ctx, joinURL, strings.Join(rest, " "))
	case "follow":
		denyExec := false
		for _, a := range rest {
			switch a {
			case "--deny-exec":
				denyExec = true
			case "-h", "--help":
				usage(os.Stdout)
				return 0
			default:
				fmt.Fprintf(os.Stderr, "slicc follow: unknown flag %q\n", a)
				return 2
			}
		}
		return cmdFollow(ctx, joinURL, denyExec)
	default:
		fmt.Fprintf(os.Stderr, "slicc: unknown subcommand %q\n", sub)
		usage(os.Stderr)
		return 2
	}
}

func usage(w *os.File) {
	fmt.Fprint(w, `slicc — headless SLICC follower CLI

Usage:
  slicc <join-url> prompt "<text>"    Stream one assistant turn from the leader, then exit
  slicc <join-url> exec "<command>"   Run a command in the leader's shell, stream stdout/stderr
  slicc <join-url> follow [--deny-exec]
                                      Stay connected as a follower. Unless --deny-exec is
                                      passed, the leader can run shell commands on THIS
                                      machine, as the user who started slicc.
  slicc --version
  slicc --help

The <join-url> is a leader's https://…/join/<token> link.
`)
}
