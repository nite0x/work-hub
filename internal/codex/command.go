package codex

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// npm's Windows shim is a .cmd file. Start its JS entry point directly so
// app-server JSONL travels over pipes without shell argument interpretation.
func Command(ctx context.Context, args ...string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		if executable, err := exec.LookPath("codex.exe"); err == nil {
			return exec.CommandContext(ctx, executable, args...)
		}
		if shim, err := exec.LookPath("codex.cmd"); err == nil {
			entry := filepath.Join(filepath.Dir(shim), "node_modules", "@openai", "codex", "bin", "codex.js")
			if _, err := os.Stat(entry); err == nil {
				return exec.CommandContext(ctx, "node.exe", append([]string{entry}, args...)...)
			}
		}
	}
	return exec.CommandContext(ctx, "codex", args...)
}
