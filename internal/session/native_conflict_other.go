//go:build !windows

package session

func nativeTerminalConflict(id, cwd string) error { return nil }
