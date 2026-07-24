package main

import "testing"

// These exercise run()'s argument dispatch — every case returns before any
// network dial (validation errors, --help, --version), so no leader is needed.
func TestRunArgDispatch(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want int
	}{
		{"no args", nil, 2},
		{"help", []string{"--help"}, 0},
		{"help short", []string{"-h"}, 0},
		{"help word", []string{"help"}, 0},
		{"version", []string{"--version"}, 0},
		{"version short", []string{"-v"}, 0},
		{"non-url first arg", []string{"notaurl", "prompt", "hi"}, 2},
		{"missing subcommand", []string{"https://x/join/t"}, 2},
		{"unknown subcommand", []string{"https://x/join/t", "bogus"}, 2},
		{"prompt missing text", []string{"https://x/join/t", "prompt"}, 2},
		{"exec missing command", []string{"https://x/join/t", "exec"}, 2},
		{"follow help", []string{"https://x/join/t", "follow", "--help"}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := run(tc.args); got != tc.want {
				t.Fatalf("run(%v) = %d, want %d", tc.args, got, tc.want)
			}
		})
	}
}
