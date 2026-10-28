package session

import (
	"bytes"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

func TestUploadedFilesReachCodexInExecutionEnvironment(t *testing.T) {
	for _, remote := range []bool{false, true} {
		t.Run(map[bool]string{false: "local", true: "remote"}[remote], func(t *testing.T) {
			a, _, c, _ := chatFixture(t)
			t.Setenv("HOME", t.TempDir())
			if remote {
				a.Workspace.Remote = testWorkspaceClient(t)
			}
			for _, file := range []struct {
				name string
				data []byte
			}{
				{"页面.html", []byte("<script>console.log('inert')</script>")},
				{"archive.zip", []byte{'P', 'K', 0, 1, 255}},
				{"unknown", []byte{0, 255, 1}},
				{"empty.txt", []byte{}},
				{"limit.bin", bytes.Repeat([]byte{0xff}, workspace.MaxAttachmentSize)},
			} {
				code, raw := call(t, a, "POST", "/api/chat-attachments", map[string]any{"name": file.name, "data": file.data})
				var result struct {
					Path string `json:"path"`
				}
				if code != 200 || json.Unmarshal(raw, &result) != nil {
					t.Fatalf("%d %s", code, raw)
				}
				root := a.Workspace.DataDir
				if remote {
					root = platform.DefaultDataDir()
				}
				if !platform.Within(filepath.Join(root, "attachments"), result.Path) {
					t.Fatal("wrong execution environment", result.Path)
				}
				got, err := os.ReadFile(result.Path)
				if err != nil || !bytes.Equal(got, file.data) {
					t.Fatalf("bytes changed: %v %v", got, err)
				}
				code, retry := call(t, a, "POST", "/api/chat-attachments", map[string]any{"name": file.name, "data": file.data})
				if code != 200 || !bytes.Equal(raw, retry) {
					t.Fatalf("retry: %d %s", code, retry)
				}
				text := "附件：" + file.name + "\n文件路径：" + result.Path
				code, raw = call(t, a, "POST", "/api/sessions/session/chat", map[string]string{"text": text, "request_id": file.name})
				if code != 202 {
					t.Fatalf("%d %s", code, raw)
				}
				awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
				c.mu.Lock()
				parts := c.startParams["input"].([]any)
				c.mu.Unlock()
				if len(parts) != 1 || parts[0].(map[string]any)["text"] != text {
					t.Fatal("attachment path did not reach Codex", parts)
				}
				c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
				awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
			}
		})
	}
}

func TestAttachmentUploadValidationAndDrafts(t *testing.T) {
	a, _, _, _ := chatFixture(t)
	for _, input := range []any{
		map[string]any{"name": "../escape", "data": []byte("x")},
		map[string]any{"name": `C:\escape`, "data": []byte("x")},
		map[string]any{"name": "bad\nname", "data": []byte("x")},
		map[string]any{"name": ".", "data": []byte("x")},
		map[string]any{"name": "a.zip", "data": make([]byte, workspace.MaxAttachmentSize+1)},
		map[string]any{"name": "a.zip", "data": "!invalid"},
		map[string]any{"name": "a.zip"},
	} {
		if code, raw := call(t, a, "POST", "/api/chat-attachments", input); code != 400 {
			t.Fatalf("%d %s", code, raw)
		}
	}
	key := "/api/conversation-drafts?key=" + url.QueryEscape("files")
	draft := map[string]any{"text": "检查文件", "images": []any{}, "files": []any{map[string]string{"id": "file", "name": "a.html", "contentType": "text/html", "text": "文件路径：/data/attachments/a.html"}}, "settings": map[string]any{}, "updated": time.Now().UnixMilli()}
	if code, raw := call(t, a, "POST", key, draft); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	if code, raw := call(t, a, "GET", key, nil); code != 200 || !strings.Contains(string(raw), "/data/attachments/a.html") {
		t.Fatalf("%d %s", code, raw)
	}
}
