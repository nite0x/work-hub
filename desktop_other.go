//go:build !windows

package main

import "fmt"

func showDesktop(_, _ string) error {
	return fmt.Errorf("桌面窗口仅在 Windows 提供；Linux 请使用 --headless")
}

func showDesktopError(_ error) {}
