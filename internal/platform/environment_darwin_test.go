package platform

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestFinderPathDiscoveryIsBoundedAndPreservesExplicitTools(t *testing.T) {
	root := t.TempDir()
	shell := filepath.Join(root, "login-shell")
	if err := os.WriteFile(shell, []byte("#!/bin/sh\nprintf 'profile noise\\000WORK_HUB_PATH\\000/opt/tools/bin:/usr/bin:relative::/opt/tools/bin\\000'\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("SHELL", shell)
	t.Setenv("PATH", "/explicit/tools/bin:/usr/bin:.")
	ConfigureCommandEnvironment()
	got := os.Getenv("PATH")
	if !strings.HasPrefix(got, "/explicit/tools/bin:/usr/bin:/opt/tools/bin:") || strings.Contains(got, "relative") || strings.Contains(got, "noise") || strings.Contains(got, ":.:") {
		t.Fatalf("invalid merged PATH: %q", got)
	}
	if strings.Count(got, "/usr/bin") != 1 {
		t.Fatal("duplicate PATH entries")
	}
	if loginPath([]byte("profile output without marker")) != "" {
		t.Fatal("profile chatter treated as PATH")
	}
	var output boundedPathOutput
	if _, err := io.Copy(&output, bytes.NewReader(bytes.Repeat([]byte("x"), 2*1024*1024))); err != nil {
		t.Fatal(err)
	}
	if len(output.Bytes()) > 1024*1024 {
		t.Fatal("unbounded profile output")
	}
}

func TestFinderPathFallbackWhenLoginShellUnavailable(t *testing.T) {
	t.Setenv("SHELL", filepath.Join(t.TempDir(), "missing-shell"))
	t.Setenv("PATH", "/usr/bin:/bin")
	ConfigureCommandEnvironment()
	for _, required := range []string{"/opt/homebrew/bin", "/usr/local/bin", filepath.Join(mustHome(t), ".local", "bin")} {
		if !strings.Contains(os.Getenv("PATH"), required) {
			t.Fatalf("missing fallback %s", required)
		}
	}
}

func mustHome(t *testing.T) string {
	t.Helper()
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	return home
}
