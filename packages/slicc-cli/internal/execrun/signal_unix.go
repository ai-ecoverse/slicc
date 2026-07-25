//go:build !windows

package execrun

import (
	"os/exec"
	"syscall"
)

// setProcAttr puts the child in a new process group (it becomes the group
// leader, pgid == pid) so killProcess can signal the whole subtree at once.
func setProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// killProcess delivers the named signal to the child's entire process group.
// Signalling the negative pid (the group id) reaches the runner AND anything it
// forked, so a `sh -c` child, a pipeline, or `docker exec` all die together.
func killProcess(cmd *exec.Cmd, name string) {
	if cmd.Process == nil {
		return
	}
	sig := syscall.SIGKILL
	switch name {
	case "SIGINT":
		sig = syscall.SIGINT
	case "SIGTERM":
		sig = syscall.SIGTERM
	}
	_ = syscall.Kill(-cmd.Process.Pid, sig)
}

// interruptProcess delivers SIGINT to the child's process group — the
// Ctrl+C-equivalent a REPL can catch to abort its current computation without
// dying. Returns true when the interrupt was actually sent.
func interruptProcess(cmd *exec.Cmd) bool {
	if cmd.Process == nil {
		return false
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGINT) == nil
}
