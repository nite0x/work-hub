package session

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/project"
	"worktree-hub/internal/workspace"
)

func TestTerminalSettingsPersistAndRejectInvalidChanges(t *testing.T) {
	a := testApp(t)
	settings := model.TerminalSettings{Kind: "custom", Path: `C:\Program Files\终端\bin\otty.exe`, Style: "otty"}
	if code, raw := call(t, a, "PUT", "/api/settings/terminal", settings); code != 200 {
		t.Fatalf("save: %d %s", code, raw)
	}
	reopened, err := openApp(a.Workspace.DataDir, a.Workspace.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Workspace.Store.DB.Close()
	got, err := reopened.Workspace.TerminalSettings()
	if err != nil || got != settings {
		t.Fatalf("settings lost after restart: %+v %v", got, err)
	}
	code, raw := call(t, reopened, "GET", "/api/state", nil)
	var state struct {
		Terminal model.TerminalAvailability `json:"terminal"`
	}
	if err := json.Unmarshal(raw, &state); err != nil || code != 200 || state.Terminal.Settings != settings {
		t.Fatalf("settings missing from state: %d %s %v", code, raw, err)
	}
	for _, invalid := range []model.TerminalSettings{
		{Kind: "unknown"},
		{Kind: "custom", Path: "otty.exe", Style: "otty"},
		{Kind: "custom", Path: "/tmp/otty", Style: "unknown"},
		{Kind: "custom", Path: "/tmp/otty\n--command=bad", Style: "otty"},
		{Kind: "custom", Path: `"C:\otty.exe" -e bad`, Style: "otty"},
	} {
		if code, raw := call(t, a, "PUT", "/api/settings/terminal", invalid); code != 400 {
			t.Fatalf("accepted invalid settings: %+v %d %s", invalid, code, raw)
		}
	}
	if got, _ := a.Workspace.TerminalSettings(); got != settings {
		t.Fatalf("invalid request changed saved settings: %+v", got)
	}
	if path, err := workspace.CustomTerminalPath(settings.Path); err != nil || path != "/mnt/c/Program Files/终端/bin/otty.exe" {
		t.Fatalf("Windows path conversion: %q %v", path, err)
	}
}

func TestTerminalCommandPreservesWSLArguments(t *testing.T) {
	p := model.LaunchPlan{Title: `订单 '"; $(touch BAD)`, Cwd: "/work/项目 with spaces", Script: "/data dir/launch 'script.sh"}
	payload := []string{"wsl.exe", "-d", "Ubuntu", "--cd", p.Cwd, "--exec", "bash", p.Script}
	for _, tc := range []struct {
		kind, style string
		prefix      []string
	}{
		{"windows-terminal", "", []string{"-w", "new", "new-tab", "--title", p.Title}},
		{"custom", "command", []string{"-e"}},
		{"custom", "windows-terminal", []string{"-w", "new", "new-tab", "--title", p.Title}},
	} {
		t.Run(tc.kind+"/"+tc.style, func(t *testing.T) {
			cmd, err := workspace.TerminalCommand(model.TerminalSettings{Kind: tc.kind, Style: tc.style}, "/program path/terminal.exe", "Ubuntu", p)
			want := append([]string{"/program path/terminal.exe"}, tc.prefix...)
			want = append(want, payload...)
			if err != nil || !reflect.DeepEqual(cmd.Args, want) {
				t.Fatalf("command arguments changed: %v %v", cmd, err)
			}
		})
	}
	for _, kind := range []string{"otty", "custom"} {
		cmd, err := workspace.TerminalCommand(model.TerminalSettings{Kind: kind, Style: "otty"}, "/program path/terminal.exe", "Ubuntu", p)
		wantCommand := `"wsl.exe" "-d" "Ubuntu" "--cd" "/work/项目 with spaces" "--exec" "bash" "/data dir/launch 'script.sh"`
		want := []string{"/program path/terminal.exe", "tab", "new", "--json", "--title", p.Title, "--command", wantCommand}
		if err != nil || !reflect.DeepEqual(cmd.Args, want) {
			t.Fatalf("Otty command lost arguments: %v %v", cmd, err)
		}
	}
	if _, err := workspace.TerminalCommand(model.TerminalSettings{Kind: "otty"}, "/otty.exe", "", p); err == nil {
		t.Fatal("Windows terminal accepted without WSL distro")
	}
	cmd, err := workspace.TerminalCommand(model.TerminalSettings{Kind: "custom", Style: "command"}, "/usr/bin/terminal", "Ubuntu", p)
	if err != nil || !reflect.DeepEqual(cmd.Args, []string{"/usr/bin/terminal", "-e", "bash", p.Script}) {
		t.Fatalf("Linux terminal used Windows bridge: %v %v", cmd, err)
	}
}

func TestAllTerminalEntrypointsUseSavedLauncher(t *testing.T) {
	a := testApp(t)
	t.Setenv("WSL_DISTRO_NAME", "Ubuntu")
	path := repo(t, "terminal repo", "master")
	testGit(t, path, "remote", "add", "origin", path)
	id := register(t, a, "Terminal", path)
	code, q, raw := create(t, a, id, nil, "terminal-settings")
	if code != 201 || q.State != "ready" {
		t.Fatalf("requirement: %d %s", code, raw)
	}
	launcherDir := t.TempDir()
	for _, entry := range []string{"codex", "resume", "git", "fetch", "login-fetch"} {
		t.Run(entry, func(t *testing.T) {
			capture := filepath.Join(launcherDir, entry+".args")
			launcher := filepath.Join(launcherDir, entry+" 终端.exe")
			script := "#!/bin/bash\nprintf '%s\\n' \"$@\" > " + platform.ShellQuote(capture) + "\nprintf '%s' '{\"ok\":true,\"data\":{\"id\":\"test-tab\"}}'\n"
			if entry == "resume" {
				ready := filepath.Join(launcherDir, "resume-ready")
				script = "#!/bin/bash\n" +
					"if [ \"$1\" = open ]; then touch " + platform.ShellQuote(ready) + "; exit 0; fi\n" +
					"if [ ! -f " + platform.ShellQuote(ready) + " ]; then echo 'Cannot connect to Otty' >&2; exit 3; fi\n" +
					"if [ ! -f " + platform.ShellQuote(ready+".initialized") + " ]; then touch " + platform.ShellQuote(ready+".initialized") + "; echo 'error: unknown command: tab.new' >&2; exit 1; fi\n" + script
			}
			if err := os.WriteFile(launcher, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			settings := model.TerminalSettings{Kind: "custom", Path: launcher, Style: "otty"}
			if code, raw := call(t, a, "PUT", "/api/settings/terminal", settings); code != 200 {
				t.Fatalf("save %d %s", code, raw)
			}
			cwd := q.Members[0].Path
			var code int
			var raw []byte
			if entry == "codex" {
				code, raw = call(t, a, "POST", "/api/requirements/"+q.ID+"/launch", nil)
			} else if entry == "resume" {
				s := codex.Session{ID: "saved-session", Cwd: cwd, Name: "继续会话"}
				fakeSessions(a, map[string]codex.Session{s.ID: s})
				if err := a.SaveSession(q.ID, s, "manual"); err != nil {
					t.Fatal(err)
				}
				code, raw = call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/"+s.ID+"/resume", nil)
			} else if entry == "git" {
				cwd = path
				code, raw = gitAction(t, a, id, project.GitAction{Action: "terminal", Path: path})
			} else {
				cwd = path
				// The normal and authentication recovery buttons use this same action.
				code, raw = gitAction(t, a, id, project.GitAction{Action: "fetch_terminal", Remote: "origin"})
			}
			if code != 200 {
				t.Fatalf("launch: %d %s", code, raw)
			}
			// The fake launcher never opens a TUI. Release its pending ownership
			// before the next entrypoint simulates a separate terminal launch.
			defer a.CloseBridges()
			args, err := os.ReadFile(capture)
			wantCommand := `"wsl.exe" "-d" "Ubuntu" "--cd" ` + workspace.WindowsQuoteArg(cwd) + ` "--exec" "bash" `
			if err != nil || !strings.HasPrefix(string(args), "tab\nnew\n--json\n--title\n") || !strings.Contains(string(args), wantCommand) {
				t.Fatalf("saved launcher was not used: %q", args)
			}
			if entry == "resume" {
				launches, err := filepath.Glob(filepath.Join(a.Workspace.DataDir, "launches", "*.sh"))
				if err != nil || len(launches) != 2 {
					t.Fatalf("expected initial and resume scripts: %v %v", launches, err)
				}
				var found bool
				for _, path := range launches {
					body, err := os.ReadFile(path)
					if err != nil {
						t.Fatal(err)
					}
					found = found || (strings.Contains(string(args), path) && strings.Contains(string(body), "codex 'resume' 'saved-session' '--cd' "+platform.ShellQuote(cwd)))
				}
				if !found {
					t.Fatal("cold-start tab did not receive the saved-session resume script")
				}
			}
		})
	}
	missing := model.TerminalSettings{Kind: "custom", Path: filepath.Join(launcherDir, "missing.exe"), Style: "otty"}
	if code, raw := call(t, a, "PUT", "/api/settings/terminal", missing); code != 200 {
		t.Fatalf("save missing: %d %s", code, raw)
	}
	if code, raw := gitAction(t, a, id, project.GitAction{Action: "terminal", Path: path}); code != 503 || !strings.Contains(string(raw), "自定义终端") {
		t.Fatalf("missing launcher must fail without falling back: %d %s", code, raw)
	}
}

func TestOttyColdStartRetriesAreBoundedAndOnlyForStartupErrors(t *testing.T) {
	for _, tc := range []struct {
		name, rejection, want string
	}{
		{"unregistered handler", "unknown command: tab.new", "初始化超时"},
		{"unavailable connection", "Cannot connect to Otty", "初始化超时"},
		{"invalid command", "invalid command arguments", "invalid command arguments"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			launcher, ready, calls := filepath.Join(dir, "otty"), filepath.Join(dir, "ready"), filepath.Join(dir, "calls")
			script := "#!/bin/bash\n" +
				"if [ \"$1\" = open ]; then touch " + platform.ShellQuote(ready) + "; exit 0; fi\n" +
				"if [ ! -f " + platform.ShellQuote(ready) + " ]; then echo 'Cannot connect to Otty' >&2; exit 3; fi\n" +
				"echo tab >> " + platform.ShellQuote(calls) + "\necho " + platform.ShellQuote(tc.rejection) + " >&2\nexit 1\n"
			if err := os.WriteFile(launcher, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			err := workspace.LaunchOttyContext(ctx, launcher, []string{"tab", "new", "--json"}, dir)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("unexpected startup result: %v", err)
			}
			log, _ := os.ReadFile(calls)
			attempts := strings.Count(string(log), "tab\n")
			if tc.name == "invalid command" && attempts != 1 {
				t.Fatalf("retried a non-startup error %d times", attempts)
			}
			if tc.name != "invalid command" && attempts < 2 {
				t.Fatalf("did not wait for GUI initialization: %d attempts", attempts)
			}
		})
	}
}

func TestOttyColdStartCreatesNewTabAndRequiresAcknowledgement(t *testing.T) {
	dir := t.TempDir()
	launcher := filepath.Join(dir, "otty.exe")
	ready, calls := filepath.Join(dir, "ready"), filepath.Join(dir, "calls")
	guiPID := filepath.Join(dir, "gui.pid")
	t.Cleanup(func() {
		if raw, err := os.ReadFile(guiPID); err == nil {
			if pid, err := strconv.Atoi(strings.TrimSpace(string(raw))); err == nil {
				if process, err := os.FindProcess(pid); err == nil {
					_ = process.Kill()
				}
			}
		}
	})
	script := "#!/bin/bash\nprintf '%s\\n' \"$1\" >> " + platform.ShellQuote(calls) + "\n" +
		"if [ \"$1\" = open ]; then sleep 30 & echo $! > " + platform.ShellQuote(guiPID) + "; touch " + platform.ShellQuote(ready) + "; exit 0; fi\n" +
		"if [ ! -f " + platform.ShellQuote(ready) + " ]; then echo 'Cannot connect to Otty: Is Otty running?' >&2; exit 3; fi\n" +
		"printf '%s' '{\"ok\":true,\"data\":{\"id\":\"new-tab\"}}'\n"
	if err := os.WriteFile(launcher, []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := workspace.LaunchOtty(launcher, []string{"tab", "new", "--json"}, dir); err != nil {
		t.Fatal(err)
	}
	log, _ := os.ReadFile(calls)
	if string(log) != "tab\nopen\ntab\n" {
		t.Fatalf("incorrect cold start sequence: %q", log)
	}
	if err := os.WriteFile(launcher, []byte("#!/bin/bash\nexit 0\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := workspace.LaunchOtty(launcher, []string{"tab", "new", "--json"}, dir); err == nil {
		t.Fatal("accepted GUI process exit without tab acknowledgement")
	}
	if err := os.WriteFile(launcher, []byte("#!/bin/bash\necho 'error: unknown command: tab.new' >&2\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := workspace.LaunchOtty(launcher, []string{"tab", "new", "--json"}, dir); err == nil || !strings.Contains(err.Error(), "当前运行中的 Otty 不支持") {
		t.Fatalf("unsupported Otty runtime was not explained: %v", err)
	}
}
