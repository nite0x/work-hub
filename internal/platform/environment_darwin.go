package platform

import (
	"bytes"
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Finder launches do not inherit the user's terminal PATH. Read only PATH from
// their login shell; retain explicit inherited tool choices and use bounded
// discovery so a slow shell configuration cannot hold the desktop indefinitely.
func ConfigureCommandEnvironment() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	shell := os.Getenv("SHELL")
	if !filepath.IsAbs(shell) {
		shell = "/bin/zsh"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, shell, "-ilc", `printf '\000WORK_HUB_PATH\000%s\000' "$PATH"`)
	cmd.Dir = home
	cmd.Stderr = io.Discard
	cmd.WaitDelay = 100 * time.Millisecond
	var output boundedPathOutput
	cmd.Stdout = &output
	var login string
	if cmd.Run() == nil {
		login = loginPath(output.Bytes())
	}
	_ = os.Setenv("PATH", mergeCommandPaths(os.Getenv("PATH"), login,
		filepath.Join(home, ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"))
}

type boundedPathOutput struct{ buffer bytes.Buffer }

func (b *boundedPathOutput) Bytes() []byte { return b.buffer.Bytes() }

func (b *boundedPathOutput) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) <= 1024*1024 {
		_, _ = b.buffer.Write(p)
	}
	return len(p), nil
}

func loginPath(raw []byte) string {
	_, value, found := bytes.Cut(raw, []byte("\x00WORK_HUB_PATH\x00"))
	if !found {
		return ""
	}
	value, _, found = bytes.Cut(value, []byte{0})
	if !found {
		return ""
	}
	return string(value)
}

func mergeCommandPaths(paths ...string) string {
	var result []string
	seen := map[string]bool{}
	for _, list := range paths {
		for _, entry := range filepath.SplitList(list) {
			// Relative and empty PATH entries must not make a repository supply
			// the Git/Codex executable used by the desktop backend.
			if !filepath.IsAbs(entry) || strings.ContainsRune(entry, '\x00') || seen[entry] {
				continue
			}
			seen[entry] = true
			result = append(result, entry)
		}
	}
	return strings.Join(result, string(os.PathListSeparator))
}
