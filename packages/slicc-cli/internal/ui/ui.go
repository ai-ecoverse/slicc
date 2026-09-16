package ui

import (
	"os"
	"strings"
)

const EnvNoTUI = "SLICC_NO_TUI"

type Env func(string) (string, bool)

type Mode struct {
	Color bool

	Sticky bool

	Unicode bool
}

func Detect(f *os.File, env Env) Mode {
	if env == nil {
		env = os.LookupEnv
	}
	if v, ok := env(EnvNoTUI); ok && v != "" && v != "0" {
		return Mode{}
	}
	term, _ := env("TERM")

	dumb := term == "dumb"
	tty := IsTerminal(f) && !dumb

	color := tty
	if v, ok := env("NO_COLOR"); ok && v != "" {
		color = false
	}
	if forcedColor(env) {
		color = !dumb
	}
	return Mode{Color: color, Sticky: tty, Unicode: unicodeCapable(env)}
}

func (m Mode) Plain() bool { return !m.Color && !m.Sticky }

func forcedColor(env Env) bool {
	for _, key := range []string{"FORCE_COLOR", "CLICOLOR_FORCE"} {
		if v, ok := env(key); ok && v != "" && v != "0" {
			return true
		}
	}
	return false
}

func unicodeCapable(env Env) bool {
	for _, key := range []string{"LC_ALL", "LC_CTYPE", "LANG"} {
		if v, ok := env(key); ok && v != "" {
			lower := strings.ToLower(v)
			return strings.Contains(lower, "utf-8") || strings.Contains(lower, "utf8")
		}
	}

	if _, ok := env("WT_SESSION"); ok {
		return true
	}
	if _, ok := env("TERM_PROGRAM"); ok {
		return true
	}
	return false
}

func IsTerminal(f *os.File) bool {
	if f == nil {
		return false
	}
	info, err := f.Stat()
	if err != nil || info.Mode()&os.ModeCharDevice == 0 {
		return false
	}
	if _, ok := terminalSize(f); !ok {
		return false
	}
	return prepareTerminal(f)
}

const DefaultWidth = 80

func Width(f *os.File, env Env) int {
	if env == nil {
		env = os.LookupEnv
	}
	if v, ok := env("COLUMNS"); ok {
		if n := atoiSafe(v); n > 0 {
			return n
		}
	}
	if n, ok := terminalSize(f); ok && n > 0 {
		return n
	}
	return DefaultWidth
}

func atoiSafe(s string) int {
	n := 0
	for _, r := range strings.TrimSpace(s) {
		if r < '0' || r > '9' {
			return 0
		}
		n = n*10 + int(r-'0')
		if n > 1<<16 {
			return 0
		}
	}
	return n
}
