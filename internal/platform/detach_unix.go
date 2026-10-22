//go:build linux || darwin

package platform

import (
	"os/exec"
	"syscall"
)

func DetachCommand(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }
