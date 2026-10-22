//go:build !windows

package main

import "os/exec"

func hideCommand(_ *exec.Cmd) {}
