package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadTextArg(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "prompt.txt")
	if err := os.WriteFile(file, []byte("from a file\n"), 0o600); err != nil {
		t.Fatalf("write temp: %v", err)
	}

	t.Run("joins multiple words verbatim", func(t *testing.T) {
		got, err := readTextArg([]string{"hello", "world"}, strings.NewReader(""))
		if err != nil || got != "hello world" {
			t.Fatalf("got %q, err %v; want \"hello world\"", got, err)
		}
	})
	t.Run("single non-@ word is literal", func(t *testing.T) {
		got, _ := readTextArg([]string{"hello"}, strings.NewReader(""))
		if got != "hello" {
			t.Fatalf("got %q, want hello", got)
		}
	})
	t.Run("@file reads the file, trimming a trailing newline", func(t *testing.T) {
		got, err := readTextArg([]string{"@" + file}, strings.NewReader(""))
		if err != nil || got != "from a file" {
			t.Fatalf("got %q, err %v; want \"from a file\"", got, err)
		}
	})
	t.Run("@- reads stdin", func(t *testing.T) {
		got, err := readTextArg([]string{"@-"}, strings.NewReader("piped in\n"))
		if err != nil || got != "piped in" {
			t.Fatalf("got %q, err %v; want \"piped in\"", got, err)
		}
	})
	t.Run("- reads stdin", func(t *testing.T) {
		got, err := readTextArg([]string{"-"}, strings.NewReader("dash stdin"))
		if err != nil || got != "dash stdin" {
			t.Fatalf("got %q, err %v; want \"dash stdin\"", got, err)
		}
	})
	t.Run("missing @file errors", func(t *testing.T) {
		if _, err := readTextArg([]string{"@" + filepath.Join(dir, "nope.txt")}, strings.NewReader("")); err == nil {
			t.Fatal("want an error for a missing @file")
		}
	})
}

func TestParseFollowArgs(t *testing.T) {
	cases := []struct {
		name       string
		in         []string
		wantRunner []string
		wantBanner bool
		wantHelp   bool
	}{
		{"bare runner", []string{"sh", "-c"}, []string{"sh", "-c"}, true, false},
		{"no-banner strips flag", []string{"--no-banner", "sh", "-c"}, []string{"sh", "-c"}, false, false},
		{"help long", []string{"--help"}, nil, true, true},
		{"help short", []string{"-h"}, nil, true, true},
		{"terminator lets runner start with a flag", []string{"--", "--no-banner"}, []string{"--no-banner"}, true, false},
		{"empty", nil, nil, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runner, banner, help := parseFollowArgs(tc.in)
			if help != tc.wantHelp || banner != tc.wantBanner || strings.Join(runner, " ") != strings.Join(tc.wantRunner, " ") {
				t.Fatalf("parseFollowArgs(%v) = (%v, banner=%v, help=%v); want (%v, banner=%v, help=%v)",
					tc.in, runner, banner, help, tc.wantRunner, tc.wantBanner, tc.wantHelp)
			}
		})
	}
}

func TestRunnerExecWarning(t *testing.T) {
	warns := map[string]bool{
		"":                         false, // no runner
		"bash":                     true,  // the classic footgun — no -c
		"bash -c":                  false,
		"sh -c":                    false,
		"/bin/zsh":                 true, // path-qualified shell, still no -c
		"docker exec -i box sh -c": false,
		"docker exec -i box bash":  true,  // trailing shell without -c
		"docker run --rm img":      true,  // wrapper, no shell at all
		"python script.py":         false, // unknown runner — don't cry wolf
		"fish -c":                  false,
		"elvish":                   true,
	}
	for runnerStr, want := range warns {
		var runner []string
		if runnerStr != "" {
			runner = strings.Fields(runnerStr)
		}
		got := runnerExecWarning(runner) != ""
		if got != want {
			t.Errorf("runnerExecWarning(%q) warned=%v, want %v (msg=%q)", runnerStr, got, want, runnerExecWarning(runner))
		}
	}
}

func TestFollowMotd(t *testing.T) {
	if followMotd(nil) != "" {
		t.Fatal("no-runner follow should advertise no motd")
	}
	motd := followMotd([]string{"sh", "-c"})
	for _, want := range []string{"exec target", "runner: sh -c", "@"} {
		if !strings.Contains(motd, want) {
			t.Errorf("motd %q missing %q", motd, want)
		}
	}
}

func TestPrintFollowBanner(t *testing.T) {
	t.Run("art + exec warning + heuristic when runner is bare bash", func(t *testing.T) {
		var buf bytes.Buffer
		printFollowBanner(&buf, []string{"bash"}, true)
		out := buf.String()
		if !strings.Contains(out, "follow") { // the ASCII wordmark ends with "follow"
			t.Error("expected the ASCII wordmark when showArt=true")
		}
		if !strings.Contains(out, "the leader can run commands") {
			t.Error("expected the exec warning")
		}
		if !strings.Contains(out, "-c") {
			t.Error("expected the bare-bash heuristic warning suggesting -c")
		}
	})
	t.Run("no art when suppressed, but exec warning stays", func(t *testing.T) {
		var buf bytes.Buffer
		printFollowBanner(&buf, []string{"sh", "-c"}, false)
		out := buf.String()
		if strings.Contains(out, "_____") {
			t.Error("art should be suppressed when showArt=false")
		}
		if !strings.Contains(out, "the leader can run commands") {
			t.Error("the exec warning must survive --no-banner")
		}
	})
	t.Run("no runner => exec-disabled notice", func(t *testing.T) {
		var buf bytes.Buffer
		printFollowBanner(&buf, nil, true)
		if !strings.Contains(buf.String(), "exec disabled") {
			t.Error("expected the exec-disabled notice for a no-runner follow")
		}
	})
}
