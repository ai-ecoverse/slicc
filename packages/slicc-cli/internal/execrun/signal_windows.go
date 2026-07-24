//go:build windows

package execrun

import "os/exec"

// Windows has no POSIX process groups / signals for child processes here, so
// there's nothing to configure up front.
func setProcAttr(_ *exec.Cmd) {}

// killProcess terminates the child. Windows can't deliver SIGINT/SIGTERM to a
// child this way, so every signal maps to a hard kill of the process.
func killProcess(cmd *exec.Cmd, _ string) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}
