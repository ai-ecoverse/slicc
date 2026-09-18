//go:build !windows

package execrun

import (
	"os/exec"
	"syscall"
)



func setProcAttr(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}




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




func interruptProcess(cmd *exec.Cmd) bool {
	if cmd.Process == nil {
		return false
	}
	return syscall.Kill(-cmd.Process.Pid, syscall.SIGINT) == nil
}
