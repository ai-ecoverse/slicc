











package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)


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
	case "update":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		defer initTelemetry("update")()
		return cmdUpdate(ctx, args[1:])
	case "list-sessions":
		return cmdListSessions(args[1:])
	case "follow-cloud", "prompt-cloud", "exec-cloud", "watch-cloud":
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		defer initTelemetry(args[0])()
		defer startUpdateNotice()()
		return cmdCloud(ctx, args[0], args[1:])
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

	
	
	
	defer initTelemetry(sub)()

	
	
	defer startUpdateNotice()()

	return dispatchJoinVerb(ctx, joinURL, sub, rest)
}


func dispatchJoinVerb(ctx context.Context, joinURL, sub string, rest []string) int {
	switch sub {
	case "prompt":
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "slicc prompt: missing prompt text")
			return 2
		}
		text, err := readTextArg(rest, os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "slicc prompt: %s\n", err)
			return 1
		}
		return cmdPrompt(ctx, joinURL, text)
	case "exec":
		if len(rest) == 0 {
			fmt.Fprintln(os.Stderr, "slicc exec: missing command")
			return 2
		}
		command, err := readTextArg(rest, os.Stdin)
		if err != nil {
			fmt.Fprintf(os.Stderr, "slicc exec: %s\n", err)
			return 1
		}
		return cmdExec(ctx, joinURL, command)
	case "watch":
		
		
		
		rest, plain := takePlainFlag(rest)
		scoopJid := ""
		if len(rest) > 0 {
			if rest[0] == "-h" || rest[0] == "--help" {
				usage(os.Stdout)
				return 0
			}
			scoopJid = rest[0]
		}
		return cmdWatch(ctx, joinURL, scoopJid, plain)
	case "follow":
		
		
		
		fa := parseFollowArgs(rest)
		if fa.help {
			usage(os.Stdout)
			return 0
		}
		return cmdFollow(ctx, joinURL, fa)
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
  slicc <join-url> watch [--plain] [scoop]
                                      Tail the leader's live agent output (a scoop jid filters) until Ctrl+C
  slicc <join-url> follow [--no-banner] [--plain] [runner...]
                                      Stay connected as a follower. If a runner is given,
                                      the leader can run commands on THIS machine — each
                                      one is executed as "<runner> <command>", as the user
                                      who started slicc. With no runner, exec is refused.
                                        follow bash -c
                                        follow sh -c
                                        follow docker exec -i sandbox sh -c
  slicc <join-url> follow --eval [--eval-quiet <dur>] <repl...>
                                      REPL mode: spawn <repl> ONCE and write each leader
                                      command as a line to its stdin; the reply is the
                                      output that follows, ended by <dur> (default 500ms)
                                      of quiet. State persists across commands.
                                        follow --eval python -i
                                        follow --eval node -i
                                        follow --eval clojure
  slicc update [--check]              Self-update to the newest released CLI binary
                                      (--check only reports; SLICC_NO_UPDATE_CHECK=1
                                      disables the once-a-day launch check)

iCloud tray sessions (macOS only — read from the signed Sliccstart launcher):
  slicc list-sessions [--json]        List active tray sessions synced from your
                                      other devices (metadata only; no join URLs)
  slicc <verb>-cloud [--index N | --session <id-prefix>] [args...]
                                      Resolve a session's join URL from iCloud
                                      (newest by default) and run <verb>, where
                                      <verb> is follow | prompt | exec | watch.
                                      Revealing the URL prompts for approval on
                                      the Mac; over SSH it is denied until you
                                      grant it once from the screen.
                                        slicc follow-cloud bash -c
                                        slicc prompt-cloud "summarize the diff"
                                        slicc exec-cloud "git status"
                                        slicc watch-cloud
                                        slicc follow-cloud --index 1 sh -c

  slicc --version
  slicc --help

The <text>/<command> argument, curl-style:
  "some text"    a literal string (multiple words are joined with spaces)
  @path          read it from the file at <path>
  @-  or  -      read it from stdin        (echo "hi" | slicc <url> prompt -)

The <join-url> is a leader's https://…/join/<token> link.

On an interactive terminal, follow/watch keep a live status bar (connection
state, uptime, heartbeat, exec + reconnect counts) below their output. Piped
output is plain by construction; --plain or SLICC_NO_TUI=1 forces it, and
NO_COLOR keeps the bar without color.
`)
}










func readTextArg(args []string, stdin io.Reader) (string, error) {
	if len(args) == 1 {
		switch a := args[0]; {
		case a == "-" || a == "@-":
			b, err := io.ReadAll(stdin)
			if err != nil {
				return "", fmt.Errorf("reading stdin: %w", err)
			}
			return strings.TrimRight(string(b), "\n"), nil
		case strings.HasPrefix(a, "@"):
			b, err := os.ReadFile(a[1:])
			if err != nil {
				return "", err
			}
			return strings.TrimRight(string(b), "\n"), nil
		}
	}
	return strings.Join(args, " "), nil
}



type followArgs struct {
	runner     []string
	showBanner bool
	help       bool
	
	
	plain bool
	
	
	eval bool
	
	
	evalQuiet time.Duration
}






func parseFollowArgs(rest []string) followArgs {
	fa := followArgs{showBanner: true}
	for len(rest) > 0 {
		switch {
		case rest[0] == "-h" || rest[0] == "--help":
			fa.help = true
			return fa
		case rest[0] == "--no-banner":
			fa.showBanner = false
			rest = rest[1:]
			continue
		case rest[0] == "--plain":
			fa.plain = true
			rest = rest[1:]
			continue
		case rest[0] == "--eval":
			fa.eval = true
			rest = rest[1:]
			continue
		case strings.HasPrefix(rest[0], "--eval-quiet="):
			fa.evalQuiet = parseEvalQuiet(rest[0][len("--eval-quiet="):])
			rest = rest[1:]
			continue
		case rest[0] == "--eval-quiet" && len(rest) > 1:
			fa.evalQuiet = parseEvalQuiet(rest[1])
			rest = rest[2:]
			continue
		case rest[0] == "--":
			fa.runner = rest[1:]
			return fa
		}
		break
	}
	fa.runner = rest
	return fa
}




func takePlainFlag(rest []string) ([]string, bool) {
	if len(rest) > 0 && rest[0] == "--plain" {
		return rest[1:], true
	}
	return rest, false
}




func parseEvalQuiet(value string) time.Duration {
	d, err := time.ParseDuration(strings.TrimSpace(value))
	if err != nil || d <= 0 {
		return 0
	}
	return d
}
