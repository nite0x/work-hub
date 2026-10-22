package platform

import (
	"runtime"
	"strings"
)

func PowershellQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
func NativeWindows() bool             { return runtime.GOOS == "windows" }
func DisplayCommand(tool string, args []string, windows bool) string {
	quote := ShellQuote
	if windows {
		quote = PowershellQuote
	}
	parts := []string{tool}
	for _, arg := range args {
		parts = append(parts, quote(arg))
	}
	if windows {
		return "& " + strings.Join(parts, " ")
	}
	return strings.Join(parts, " ")
}

func ShellQuote(v string) string { return "'" + strings.ReplaceAll(v, "'", "'\"'\"'") + "'" }
