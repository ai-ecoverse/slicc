//go:build unix

package ui

import (
	"os"

	"golang.org/x/sys/unix"
)



func terminalSize(f *os.File) (int, bool) {
	ws, err := unix.IoctlGetWinsize(int(f.Fd()), unix.TIOCGWINSZ)
	if err != nil {
		return 0, false
	}
	return int(ws.Col), true
}


func prepareTerminal(*os.File) bool { return true }
