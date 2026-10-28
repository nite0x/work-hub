package session

import (
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSessionFilePreviewResolvesLinesAndRemoteEnvironment(t *testing.T) {
	for _, remote := range []bool{false, true} {
		t.Run(map[bool]string{false: "local", true: "remote"}[remote], func(t *testing.T) {
			a, _, c, _ := chatFixture(t)
			if remote {
				a.Workspace.Remote = testWorkspaceClient(t)
			}
			file := filepath.Join(c.cwd, "预览 file.go")
			if err := os.WriteFile(file, []byte(strings.Repeat("正文\r\n", 600)+"末行"), 0600); err != nil {
				t.Fatal(err)
			}
			code, raw := call(t, a, "GET", "/api/sessions/session/file?path="+url.QueryEscape("预览 file.go")+"&line=350", nil)
			var v struct {
				Path  string   `json:"path"`
				Lines []string `json:"lines"`
				Start int      `json:"start_line"`
				Total int      `json:"total_lines"`
				Line  int      `json:"line"`
			}
			if code != 200 || json.Unmarshal(raw, &v) != nil || v.Path != file || v.Line != 350 || v.Total != 601 || v.Start != 150 || len(v.Lines) != 401 || v.Lines[0] != "正文" {
				t.Fatalf("%d %s", code, raw)
			}
			if code, raw = call(t, a, "GET", "/api/sessions/session/file?path="+url.QueryEscape(file)+"&line=900", nil); code != 200 || !strings.Contains(string(raw), `"line":601`) {
				t.Fatalf("%d %s", code, raw)
			}
			if code, _ := call(t, a, "GET", "/api/sessions/session/file?path=missing", nil); code != 400 {
				t.Fatal(code)
			}
			if code, _ := call(t, a, "GET", "/api/sessions/session/file?path=missing&line=-1", nil); code != 400 {
				t.Fatal(code)
			}
		})
	}
}

func TestSessionFilePreviewRestrictsRootsAndFileTypes(t *testing.T) {
	a, _, c, _ := chatFixture(t)
	extra := t.TempDir()
	outside := t.TempDir()
	if err := a.Workspace.Store.SaveSessionDirectories("session", []string{extra}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(extra, "allowed.txt"), filepath.Join(outside, "secret.txt")} {
		if err := os.WriteFile(path, []byte("example"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if code, raw := call(t, a, "GET", "/api/sessions/session/file?path="+url.QueryEscape(filepath.Join(extra, "allowed.txt")), nil); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(c.cwd, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(c.cwd, "binary"), []byte{0, 1, 2}, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(c.cwd, "large"), []byte(strings.Repeat("a", 513<<10)), 0600); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(outside, "secret.txt"), "escape", "binary", "large", c.cwd} {
		if code, raw := call(t, a, "GET", "/api/sessions/session/file?path="+url.QueryEscape(path), nil); code != 400 {
			t.Fatalf("%s: %d %s", path, code, raw)
		}
	}
}

func TestChatWebLinksOpenExternallyWithoutNavigatingApp(t *testing.T) {
	a, _, _, _ := chatFixture(t)
	opened := ""
	a.openExternal = func(u string) error { opened = u; return nil }
	path := "/api/sessions/session/open-link"
	if code, raw := call(t, a, "POST", path, map[string]string{"url": "https://example.com/docs#section"}); code != 200 || opened != "https://example.com/docs#section" {
		t.Fatalf("%d %s %s", code, raw, opened)
	}
	for _, u := range []string{"javascript:alert(1)", "file:///tmp/a.txt", "/relative"} {
		if code, _ := call(t, a, "POST", path, map[string]string{"url": u}); code != 400 {
			t.Fatal(u, code)
		}
	}
}
