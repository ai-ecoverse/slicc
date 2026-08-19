//go:build !unix && !windows

package ui

import "os"

// terminalSize has no portable implementation on the remaining platforms
// (js/wasm, plan9), so they always take the plain-output path.
func terminalSize(*os.File) (int, bool) { return 0, false }

func prepareTerminal(*os.File) bool { return false }
