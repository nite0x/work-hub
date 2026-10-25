//go:build !windows && !darwin

package session

func nativeTerminalConflict(id, cwd string) error { return nil }
