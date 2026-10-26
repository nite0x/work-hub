package app

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

// A process boundary fixture: no real Codex data or model turns are used.
func TestWorkspaceCatalogCodexProcess(t *testing.T) {
	if os.Getenv("WORK_HUB_CATALOG_FIXTURE") != "1" {
		return
	}
	scan := bufio.NewScanner(os.Stdin)
	for scan.Scan() {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		if json.Unmarshal(scan.Bytes(), &request) != nil {
			os.Exit(2)
		}
		if len(request.ID) == 0 {
			continue
		}
		var result any
		switch request.Method {
		case "initialize":
			result = map[string]any{}
		case "model/list":
			result = map[string]any{"data": []any{map[string]any{"id": "fixture", "model": "fixture-model", "displayName": "Fixture model", "isDefault": true, "defaultReasoningEffort": "high"}}}
		case "collaborationMode/list":
			result = map[string]any{"data": []any{map[string]string{"mode": "default"}, map[string]string{"mode": "plan"}}}
		default:
			os.Exit(3)
		}
		if json.NewEncoder(os.Stdout).Encode(map[string]any{"id": request.ID, "result": result}) != nil {
			os.Exit(4)
		}
	}
	os.Exit(0)
}

func TestRemoteChatOptionsCrossWorkspaceHelperBoundary(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell fixture; actual Windows to WSL transport has its own opt-in test")
	}
	bin, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	wrapper := "#!/bin/sh\nexec " + platform.ShellQuote(bin) + " -test.run=^TestWorkspaceCatalogCodexProcess$\n"
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte(wrapper), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("WORK_HUB_CATALOG_FIXTURE", "1")
	client := testWorkspaceClient(t)
	a, err := openAppForWorkspace(filepath.Join(t.TempDir(), "metadata"), t.TempDir(), client)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.Close() })
	code, raw := call(t, a, "GET", "/api/codex/chat-options", nil)
	var catalog struct {
		Models []struct {
			Model string `json:"model"`
		} `json:"models"`
		Modes []string `json:"modes"`
	}
	if err := json.Unmarshal(raw, &catalog); err != nil || code != 200 || len(catalog.Models) != 1 || catalog.Models[0].Model != "fixture-model" || strings.Join(catalog.Modes, ",") != "default,plan" {
		t.Fatalf("remote model picker: %d %s (%v)", code, raw, err)
	}
	for _, method := range []string{"thread/start", "turn/start", "thread/delete", "thread/name/set", "config/value/write"} {
		if err := client.Call(context.Background(), workspace.Request{Op: "session", Method: method}, nil); err == nil || !strings.Contains(err.Error(), "只支持读取") {
			t.Fatalf("mutating method %s passed the read-only helper: %v", method, err)
		}
	}
}
