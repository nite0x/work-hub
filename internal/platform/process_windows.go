package platform

import (
	"os/exec"
	"syscall"
)

func HideCommand(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true} }
