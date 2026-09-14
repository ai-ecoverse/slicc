//go:build !unix && !windows

package ui

import "os"



func terminalSize(*os.File) (int, bool) { return 0, false }

func prepareTerminal(*os.File) bool { return false }
