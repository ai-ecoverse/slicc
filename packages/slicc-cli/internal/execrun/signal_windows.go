//go:build windows

package execrun

import "os/exec"

func setProcAttr(_ *exec.Cmd) {}

func killProcess(cmd *exec.Cmd, _ string) {
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func interruptProcess(_ *exec.Cmd) bool { return false }
