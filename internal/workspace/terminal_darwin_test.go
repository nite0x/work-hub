package workspace

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"worktree-hub/internal/model"
)

func TestMacTerminalDocumentPreservesPathsArgumentsAndBackendTools(t *testing.T) {
	root := t.TempDir()
	cwd := filepath.Join(root, "项目 ' with spaces & $(touch UNEXPECTED)")
	if err := os.Mkdir(cwd, 0700); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "tool bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "codex"), []byte("#!/bin/sh\nprintf '%s\\000' \"$PWD\" \"$CODEX_HOME\" \"$@\" > \"$WORK_HUB_ARGV_CAPTURE\"\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":/usr/bin:/bin")
	t.Setenv("SHELL", "/usr/bin/true")
	codexHome := filepath.Join(root, "custom ' codex home")
	t.Setenv("CODEX_HOME", codexHome)
	capture := filepath.Join(root, "argv")
	t.Setenv("WORK_HUB_ARGV_CAPTURE", capture)
	plan := model.LaunchPlan{Tool: "codex", Cwd: cwd, Args: []string{"resume", "session'; $(touch UNEXPECTED)", "--cd", cwd, "--add-dir", filepath.Join(root, "other project")}}
	if err := WriteTerminalScript(root, &plan); err != nil {
		t.Fatal(err)
	}
	if filepath.Ext(plan.Script) != ".command" {
		t.Fatal("not a Terminal executable document")
	}
	info, err := os.Stat(plan.Script)
	if err != nil || info.Mode().Perm() != 0700 {
		t.Fatalf("unsafe script permissions: %v", err)
	}
	command := exec.Command("/bin/bash", plan.Script)
	command.Env = append(os.Environ(), "PATH=/usr/bin:/bin") // Terminal's inherited PATH differs.
	if raw, err := command.CombinedOutput(); err != nil {
		t.Fatalf("script failed: %v %s", err, raw)
	}
	raw, err := os.ReadFile(capture)
	if err != nil {
		t.Fatal(err)
	}
	got := strings.Split(strings.TrimSuffix(string(raw), "\x00"), "\x00")
	want := append([]string{cwd, codexHome}, plan.Args...)
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("changed shell arguments: %q", got)
	}
	if _, err := os.Stat(filepath.Join(cwd, "UNEXPECTED")); !os.IsNotExist(err) {
		t.Fatal("shell interpreted user text")
	}
	for _, kind := range []string{"macos-terminal", "auto"} {
		cmd, err := TerminalCommand(model.TerminalSettings{Kind: kind}, "/System/Applications/Utilities/Terminal.app", "", plan)
		if err != nil || !reflect.DeepEqual(cmd.Args, []string{"/usr/bin/open", "-a", "/System/Applications/Utilities/Terminal.app", plan.Script}) {
			t.Fatalf("bad LaunchServices arguments: %v %v", cmd, err)
		}
	}
}

func TestMacTerminalDefaultAndAvailability(t *testing.T) {
	settings := DefaultTerminalSettings()
	if settings.Kind != "macos-terminal" {
		t.Fatalf("wrong macOS default: %+v", settings)
	}
	v := Availability(settings)
	if !v.Available || v.Platform != "darwin" || !strings.HasSuffix(v.Launcher, "Terminal.app") {
		t.Fatalf("Terminal unavailable: %+v", v)
	}
	cache := newTerminalCache(func(_ context.Context, _ model.TerminalSettings) model.TerminalAvailability { return v })
	defer cache.Close()
	value, _ := cache.snapshot(settings, false)
	if value.Platform != "darwin" || len(value.Kinds) == 0 || value.Kinds[0] != "macos-terminal" {
		t.Fatal("pending discovery lost platform choices")
	}
}
