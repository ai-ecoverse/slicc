//go:build unix

package ui

import (
	"os"

	"golang.org/x/sys/unix"
)

// terminalSize returns the terminal's column count, and false when f is not a
// terminal (the ioctl fails for pipes, files and /dev/null).
func terminalSize(f *os.File) (int, bool) {
	ws, err := unix.IoctlGetWinsize(int(f.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		return 0, false
	}
	return int(ws.Col), true
}

// prepareTerminal is a no-op on unix: ANSI support needs no opt-in.
func prepareTerminal(*os.File) bool { return true }
