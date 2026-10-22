//go:build !windows

package platform

import "os/exec"

func HideCommand(_ *exec.Cmd) {}
