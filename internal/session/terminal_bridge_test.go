package session

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
)

func socketPair(t *testing.T) (*websocket.Conn, *websocket.Conn) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			accepted <- c
		}
	}))
	t.Cleanup(s.Close)
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(s.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	peer := <-accepted
	t.Cleanup(func() { c.Close(); peer.Close() })
	return c, peer
}
func TestManagedMultiProjectLaunchMovesAdditionalRootsToBridge(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("managed terminal relay requires Linux peer credentials")
	}
	a := testApp(t)
	front := register(t, a, "Front", repo(t, "front", "master"))
	back := register(t, a, "Back", repo(t, "back", "master"))
	_, q, _ := create(t, a, front, []string{back}, "terminal-roots")
	var plan model.LaunchPlan
	a.Workspace.Launch = func(p model.LaunchPlan, _ func()) error { plan = p; return nil }
	endpoint := "/api/requirements/" + q.ID + "/launch"
	if code, raw := call(t, a, "GET", endpoint, nil); code != 200 || !strings.Contains(string(raw), "--add-dir") {
		t.Fatalf("standalone command lost additional directories: %d %s", code, raw)
	}
	if code, raw := call(t, a, "POST", endpoint, nil); code != 200 {
		t.Fatalf("launch: %d %s", code, raw)
	}
	if strings.Contains(plan.Command, "--add-dir") || !strings.Contains(plan.Command, "--remote") {
		t.Fatalf("incompatible managed arguments: %s", plan.Command)
	}
	b := a.bridges[strings.TrimPrefix(plan.Args[len(plan.Args)-1], "unix://")]
	if b == nil || len(plan.AdditionalDirectories) != 1 || !reflect.DeepEqual(b.additionalDirectories, plan.AdditionalDirectories) {
		t.Fatalf("missing managed roots: %+v", plan)
	}
	if err := exec.Command("bash", "-n", plan.Script).Run(); err != nil {
		t.Fatal(err)
	}
	if os.Getenv("WORKTREE_HUB_TEST_INSTALLED_CODEX") == "1" {
		checkInstalledManagedArgs(t, plan)
		b.Close()
		id := "00000000-0000-4000-8000-000000000001"
		s := codex.Session{ID: id, Cwd: plan.Cwd}
		fakeSessions(a, map[string]codex.Session{id: s})
		if err := a.SaveSession(q.ID, s, "workspace"); err != nil {
			t.Fatal(err)
		}
		if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/"+id+"/resume", nil); code != 200 {
			t.Fatalf("resume: %d %s", code, raw)
		}
		checkInstalledManagedArgs(t, plan)
	}
}

// Exercise the installed CLI parser in a PTY, directing it to a nonexistent
// socket so no real session, model turn, or user's terminal can be started.
func checkInstalledManagedArgs(t *testing.T, plan model.LaunchPlan) {
	t.Helper()
	args := append([]string{}, plan.Args...)
	args[len(args)-1] = "unix://" + filepath.Join(t.TempDir(), "missing.sock")
	parts := []string{"codex"}
	for _, arg := range args {
		parts = append(parts, platform.ShellQuote(arg))
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "script", "-q", "-e", "-c", strings.Join(parts, " "), "/dev/null")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color")
	output, err := cmd.CombinedOutput()
	if err == nil || ctx.Err() != nil || !strings.Contains(string(output), "failed to connect to remote app server") || strings.Contains(string(output), "--add-dir is not supported") {
		t.Fatalf("CLI rejected managed arguments before connecting: %v %s", err, output)
	}
}

func TestBridgeAddsTaskRootsToTurnsAfterStartAndResume(t *testing.T) {
	for _, method := range []string{"thread/start", "thread/resume"} {
		t.Run(method, func(t *testing.T) {
			a, q, _, _ := chatFixture(t)
			up, server := socketPair(t)
			client, _ := socketPair(t)
			_ = server.SetReadDeadline(time.Now().Add(2 * time.Second))
			cwd := q.Members[0].Path
			extra := t.TempDir()
			b := &terminalBridge{app: a.Service, requirement: q.ID, cwd: cwd, additionalDirectories: []string{extra, extra, cwd}, upstream: up, client: client, pending: map[string]bridgeCall{"1": {Method: method}}}
			response, _ := json.Marshal(map[string]any{"id": 1, "result": map[string]any{
				"thread":  map[string]any{"id": "session", "cwd": cwd},
				"sandbox": map[string]any{"type": "workspaceWrite", "writableRoots": []string{"/existing-root"}, "networkAccess": false, "excludeTmpdirEnvVar": true},
			}})
			b.observe(response)
			for _, explicit := range []bool{false, true} {
				params := map[string]any{"threadId": "session", "input": []any{map[string]string{"type": "text", "text": "keep me"}}, "approvalPolicy": "on-request", "model": "keep-model"}
				wantRoots := []string{"/existing-root", cwd, extra}
				wantNetwork := false
				if explicit {
					params["sandboxPolicy"] = map[string]any{"type": "workspaceWrite", "writableRoots": []string{"/explicit-root", extra}, "networkAccess": true, "excludeTmpdirEnvVar": true}
					wantRoots = []string{"/explicit-root", extra, cwd}
					wantNetwork = true
				} else {
					params["sandboxPolicy"] = nil
				}
				raw, _ := json.Marshal(map[string]any{"id": 2, "method": "turn/start", "params": params})
				if err := b.forward(raw); err != nil {
					t.Fatal(err)
				}
				_, forwarded, err := server.ReadMessage()
				if err != nil {
					t.Fatal(err)
				}
				var message struct {
					Params struct {
						ApprovalPolicy string `json:"approvalPolicy"`
						Model          string `json:"model"`
						Sandbox        struct {
							Roots      []string `json:"writableRoots"`
							Network    bool     `json:"networkAccess"`
							ExcludeTmp bool     `json:"excludeTmpdirEnvVar"`
						} `json:"sandboxPolicy"`
					} `json:"params"`
				}
				if err := json.Unmarshal(forwarded, &message); err != nil {
					t.Fatal(err)
				}
				p := message.Params
				if !reflect.DeepEqual(p.Sandbox.Roots, wantRoots) || p.Sandbox.Network != wantNetwork || !p.Sandbox.ExcludeTmp || p.ApprovalPolicy != "on-request" || p.Model != "keep-model" || !strings.Contains(string(forwarded), "keep me") {
					t.Fatalf("turn settings changed: %s", forwarded)
				}
			}
		})
	}
}

func TestBridgeDoesNotBroadenOtherSandboxModes(t *testing.T) {
	for _, mode := range []string{"readOnly", "dangerFullAccess", "externalSandbox"} {
		for _, explicit := range []bool{false, true} {
			b := &terminalBridge{cwd: "/primary", additionalDirectories: []string{"/other"}, sandbox: json.RawMessage(`{"type":"workspaceWrite","writableRoots":["/primary"]}`)}
			policy, _ := json.Marshal(map[string]string{"type": mode})
			params := map[string]any{"threadId": "session"}
			if explicit {
				params["sandboxPolicy"] = json.RawMessage(policy)
			} else {
				b.sandbox = policy
			}
			raw, _ := json.Marshal(map[string]any{"id": 1, "method": "turn/start", "params": params})
			got, err := b.withWorkspaceRoots(raw)
			if err != nil || string(got) != string(raw) {
				t.Fatalf("changed %s policy: %s %v", mode, got, err)
			}
		}
	}
}

func TestBridgeGatesNextTurnButForwardsExistingApprovalWhileDraining(t *testing.T) {
	a, q, _, _ := chatFixture(t)
	up, server := socketPair(t)
	client, tui := socketPair(t)
	b := &terminalBridge{app: a.Service, requirement: q.ID, session: "session", cwd: q.Members[0].Path, upstream: up, client: client, pending: map[string]bridgeCall{}}
	raw := []byte(`{"id":1,"method":"turn/start","params":{"threadId":"session","input":[]}}`)
	if err := b.forward(raw); err != nil {
		t.Fatal(err)
	}
	_, got, err := server.ReadMessage()
	if err != nil || string(got) != string(raw) {
		t.Fatal(string(got), err)
	}
	b.observe([]byte(`{"id":1,"result":{"turn":{"id":"turn"}}}`))
	b.mu.Lock()
	active := b.active
	b.draining = true
	b.mu.Unlock()
	if !active {
		t.Fatal("missing active turn")
	}
	if err := b.forward([]byte(`{"id":2,"method":"turn/start","params":{"threadId":"session"}}`)); err != nil {
		t.Fatal(err)
	}
	_, blocked, err := tui.ReadMessage()
	if err != nil || !strings.Contains(string(blocked), "等待本轮") {
		t.Fatal(string(blocked), err)
	}
	approval := []byte(`{"id":"approval","result":{"decision":"accept"}}`)
	if err := b.forward(approval); err != nil {
		t.Fatal(err)
	}
	_, got, err = server.ReadMessage()
	if err != nil || string(got) != string(approval) {
		t.Fatal(string(got), err)
	}
	b.observe([]byte(`{"method":"turn/completed","params":{"threadId":"session","turn":{"id":"turn","status":"completed"}}}`))
	ctx, end := context.WithTimeout(context.Background(), time.Second)
	defer end()
	if err := b.handoff(ctx, func() (bool, error) { return true, nil }); err != nil {
		t.Fatal(err)
	}
	if !b.revoked {
		t.Fatal("relay was not revoked")
	}
}

func TestUnconnectedTerminalLaunchExpiresWithoutBlockingRetry(t *testing.T) {
	a, q, _, endpoint := chatFixture(t)
	b, err := a.NewTerminalBridge(q.ID, q.Members[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	b.session = "session"
	b.mu.Unlock()
	code, raw := call(t, a, "GET", endpoint, nil)
	var state ChatState
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	if code != 200 || state.CanHandoff || !strings.Contains(state.Blocked, "终端正在启动") || !strings.Contains(state.Notice, "正在等待终端连接") {
		t.Fatalf("pending launch: %d %s", code, raw)
	}
	b.watchLaunch(20 * time.Millisecond)
	if err := a.AppTerminalConflict("session", b.cwd); err != nil {
		t.Fatal("expired launch still owns cwd:", err)
	}
	if a.TerminalOwner("session", b.cwd) != nil {
		t.Fatal("expired bridge still registered")
	}
	if _, err := os.Stat(b.socket); !os.IsNotExist(err) {
		t.Fatal("expired socket still present:", err)
	}
	code, raw = call(t, a, "GET", endpoint, nil)
	state = ChatState{}
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	if code != 200 || state.Blocked != "" {
		t.Fatalf("launch still blocks sidebar: %s", raw)
	}
}

func TestLaunchWatchKeepsConnectedTerminal(t *testing.T) {
	a, q, _, _ := chatFixture(t)
	b, err := a.NewTerminalBridge(q.ID, q.Members[0].Path)
	if err != nil {
		t.Fatal(err)
	}
	b.mu.Lock()
	b.connected = true
	b.session = "session"
	b.mu.Unlock()
	b.watchLaunch(20 * time.Millisecond)
	if err := a.AppTerminalConflict("session", b.cwd); err == nil || !strings.Contains(err.Error(), "保有") {
		t.Fatal("connected terminal lost ownership:", err)
	}
}

func TestTerminalScriptFailureReleasesReservationAndAllowsRetry(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("managed terminal relay requires Linux peer credentials")
	}
	for _, mode := range []string{"login", "codex"} {
		t.Run(mode, func(t *testing.T) {
			a, q, _, _ := chatFixture(t)
			fakeSessions(a, map[string]codex.Session{"session": {ID: "session", Cwd: q.Members[0].Path}})
			var plan model.LaunchPlan
			a.Workspace.Launch = func(p model.LaunchPlan, _ func()) error { plan = p; return nil }
			endpoint := "/api/requirements/" + q.ID + "/sessions/session/resume"
			if code, raw := call(t, a, "POST", endpoint, nil); code != 200 {
				t.Fatalf("launch: %d %s", code, raw)
			}
			b := a.TerminalOwner("session", plan.Cwd)
			if b == nil {
				t.Fatal("missing launch reservation")
			}
			fakeCodex := "codex() { return 1; }; "
			if mode == "codex" {
				fakeCodex = "codex() { if [ \"$1\" = login ]; then return 0; fi; return 2; }; "
			}
			cmd := exec.Command("bash", "-c", fakeCodex+"export -f codex; bash "+platform.ShellQuote(plan.Script))
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("script: %v %s", err, out)
			}
			select {
			case <-b.done:
			case <-time.After(2 * time.Second):
				t.Fatal("failed launch retained reservation")
			}
			if err := a.AppTerminalConflict("session", plan.Cwd); err != nil {
				t.Fatal("failed launch blocks retry:", err)
			}
			if code, raw := call(t, a, "POST", endpoint, nil); code != 200 {
				t.Fatalf("retry: %d %s", code, raw)
			}
		})
	}
}

// Real CLI + real shared daemon, on an isolated temporary requirement. This
// sends one tool-free prompt and never resumes or terminates a user's session.
func TestInstalledCodexNewSessionAndManagedTerminalHandoff(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("managed terminal relay requires Linux peer credentials")
	}
	if os.Getenv("WORKTREE_HUB_TEST_CODEX_TURN") != "1" {
		t.Skip("opt-in real new-session / TUI handoff")
	}
	a := testApp(t)
	// Remote trust prompts are saved by the shared daemon. Remove only this
	// run's temporary project entries, preserving all pre-existing settings.
	testPrefix := filepath.Dir(filepath.Dir(a.Workspace.DataDir))
	t.Cleanup(func() {
		home, _ := os.UserHomeDir()
		codexHome := os.Getenv("CODEX_HOME")
		if codexHome == "" {
			codexHome = filepath.Join(home, ".codex")
		}
		config := filepath.Join(codexHome, "config.toml")
		raw, err := os.ReadFile(config)
		if err != nil {
			return
		}
		pattern := regexp.MustCompile(`(?m)^` + regexp.QuoteMeta(`[projects."`+testPrefix) + `[^\n]*\]\r?\ntrust_level = "trusted"\r?\n(?:\r?\n)?`)
		clean := pattern.ReplaceAll(raw, nil)
		if len(clean) != len(raw) {
			if err := os.WriteFile(config, clean, 0600); err != nil {
				t.Error(err)
			}
		}
	})
	p := register(t, a, "Managed", repo(t, "managed", "master"))
	_, q, _ := create(t, a, p, nil, "managed-handoff")
	endpoint := "/api/requirements/" + q.ID + "/sessions/new"
	code, raw := call(t, a, "POST", endpoint, map[string]string{"text": "这是连通性测试。只回复 NEW_SESSION_OK，不调用工具，不读取文件。", "request_id": "installed-new"})
	if code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	var result struct {
		Session RequirementSession `json:"session"`
	}
	_ = json.Unmarshal(raw, &result)
	ctx, end := context.WithTimeout(context.Background(), 90*time.Second)
	defer end()
	defer func() {
		c, err := codex.OpenLive(context.Background())
		if err == nil {
			defer c.Close()
			cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
			defer done()
			_ = c.Call(cleanup, "thread/delete", map[string]any{"threadId": result.Session.ID}, nil)
		}
	}()
	run := a.ChatFor(result.Session.ID)
	select {
	case <-run.finished:
	case <-ctx.Done():
		t.Fatal("new turn timed out")
	}
	if s := run.snapshot(); s.Status != "completed" {
		t.Fatalf("new session: %+v", s)
	}
	var plan model.LaunchPlan
	a.Workspace.Launch = func(p model.LaunchPlan, _ func()) error { plan = p; return nil }
	base := "/api/requirements/" + q.ID + "/sessions/" + result.Session.ID
	if code, raw := call(t, a, "POST", base+"/resume", nil); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	log, err := os.CreateTemp(t.TempDir(), "tui-log")
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	trust := "projects." + strconv.Quote(plan.Cwd) + ".trust_level=\"trusted\""
	prompt := "只逐行输出从 1 到 80 的整数，最后一行输出 HANDOFF_COMPLETED。不要调用工具，不读取文件。"
	cmd := exec.CommandContext(ctx, "script", "-q", "-c", "stty rows 35 cols 120; "+plan.Command+" -c "+platform.ShellQuote(trust)+" "+platform.ShellQuote(prompt), "/dev/null")
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "CODEX_HOME="+t.TempDir())
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	cmd.Stdout = log
	cmd.Stderr = log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill(); _ = cmd.Wait() }()
	var b *terminalBridge
	trusted := false
	for {
		data, _ := os.ReadFile(log.Name())
		if !trusted && strings.Contains(string(data), "Trust and continue") {
			n, err := input.Write([]byte("\r"))
			t.Logf("accepted own temporary test folder: %d %v", n, err)
			trusted = true
		}
		b = a.BridgeFor(result.Session.ID)
		if b != nil {
			b.mu.Lock()
			ready := len(b.pending) == 0 && b.client != nil && b.active
			b.mu.Unlock()
			if ready {
				break
			}
		}
		select {
		case <-ctx.Done():
			a.bridgeMu.Lock()
			for _, candidate := range a.bridges {
				candidate.mu.Lock()
				t.Logf("bridge connected=%t bound=%t revoked=%t pending=%v", candidate.connected, candidate.bound, candidate.revoked, candidate.pending)
				candidate.mu.Unlock()
			}
			a.bridgeMu.Unlock()
			data, _ := os.ReadFile(log.Name())
			t.Fatalf("TUI never connected: %s", data)
		case <-time.After(100 * time.Millisecond):
		}
	}
	if code, raw := call(t, a, "POST", base+"/chat/handoff", map[string]string{"request_id": "installed-handoff"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	run = a.ChatFor(result.Session.ID)
	select {
	case <-run.finished:
	case <-ctx.Done():
		t.Fatal("handoff timed out")
	}
	if s := run.snapshot(); s.Status != "idle" {
		t.Fatalf("handoff: %+v", s)
	}
	c, err := a.openSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	session, err := readSession(c, result.Session.ID)
	if err != nil {
		t.Fatal(err)
	}
	history, err := readSessionHistory(c, session, "")
	if err != nil {
		t.Fatal(err)
	}
	text := ""
	for _, entry := range history.Entries {
		if entry.Kind == "assistant" {
			text += entry.Text
		}
	}
	if !strings.Contains(text, "HANDOFF_COMPLETED") {
		t.Fatal("terminal's streamed reply was truncated by handoff")
	}
}
