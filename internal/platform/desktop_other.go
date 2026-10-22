//go:build !windows

package platform

import "fmt"

func ShowDesktop(_, _ string) error {
	return fmt.Errorf("桌面窗口仅在 Windows 提供；Linux 请使用 --headless")
}

func ShowDesktopError(_ error) {}
