//go:build windows

package ui

import (
	"os"

	"golang.org/x/sys/windows"
)

// terminalSize returns the console's column count, and false when f is not a
// console handle.
func terminalSize(f *os.File) (int, bool) {
	var info windows.ConsoleScreenBufferInfo
	if err := windows.GetConsoleScreenBufferInfo(windows.Handle(f.Fd()), &info); err != nil {
		return 0, false
	}
	// Window, not buffer: the buffer is usually far wider than what is shown.
	return int(info.Window.Right - info.Window.Left + 1), true
}

// prepareTerminal opts the console into ANSI escape-sequence processing, which
// Windows leaves off for legacy consoles. A console that refuses is reported as
// non-interactive so the caller falls back to plain output rather than printing
// raw escape sequences.
func prepareTerminal(f *os.File) bool {
	handle := windows.Handle(f.Fd())
	var mode uint32
	if err := windows.GetConsoleMode(handle, &mode); err != nil {
		return false
	}
	if mode&windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING != 0 {
		return true
	}
	return windows.SetConsoleMode(handle, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING) == nil
}
