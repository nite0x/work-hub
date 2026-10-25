package codex

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestDaemonCommandUsesManagedMacRuntime(t *testing.T) {
	root := t.TempDir()
	t.Setenv("CODEX_HOME", root)
	managed := filepath.Join(root, "packages", "app-server-daemon", "current", "bin", "codex")
	if err := os.MkdirAll(filepath.Dir(managed), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(managed, []byte("#!/bin/sh\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"start", "version"} {
		cmd := Command(context.Background(), "app-server", "daemon", action)
		if cmd.Path != managed {
			t.Fatal("daemon command ignored installed runtime")
		}
	}
	if cmd := Command(context.Background(), "app-server"); cmd.Path == managed {
		t.Fatal("changed the explicitly selected session CLI")
	}
	if err := os.Chmod(managed, 0600); err != nil {
		t.Fatal(err)
	}
	if cmd := Command(context.Background(), "app-server", "daemon", "start"); cmd.Path == managed {
		t.Fatal("selected a non-executable runtime")
	}
	t.Setenv("CODEX_HOME", ".codex")
	if cmd := Command(context.Background(), "app-server", "daemon", "start"); !filepath.IsAbs(cmd.Path) && cmd.Path != "codex" {
		t.Fatal("selected a repository-relative runtime")
	}
}
