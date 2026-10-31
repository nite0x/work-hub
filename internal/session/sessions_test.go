package session

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/model"
)

type fakeSessionClient struct {
	request func(string, map[string]any) (any, error)
}

func (c *fakeSessionClient) Close() {}
func (c *fakeSessionClient) Call(method string, params any, out any) error {
	value, err := c.request(method, params.(map[string]any))
	if err != nil {
		return err
	}
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

func fakeSessions(a *App, sessions map[string]codex.Session) {
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, p map[string]any) (any, error) {
			if method == "thread/read" {
				if p["includeTurns"] != false {
					return nil, fmt.Errorf("must not read transcripts")
				}
				s, ok := sessions[p["threadId"].(string)]
				if !ok {
					return nil, fmt.Errorf("session not found")
				}
				return map[string]any{"thread": s}, nil
			}
			if method != "thread/list" {
				return nil, fmt.Errorf("unexpected method %s", method)
			}
			page := codex.SessionPage{Data: []codex.Session{}}
			for _, s := range sessions {
				if paths, ok := p["cwd"].([]string); ok {
					matches := false
					for _, path := range paths {
						if s.Cwd == path {
							matches = true
						}
					}
					if !matches {
						continue
					}
				}
				page.Data = append(page.Data, s)
			}
			return page, nil
		}}, nil
	}
}

func getRequirementSessions(t *testing.T, a *App, id string) []RequirementSession {
	t.Helper()
	code, raw := call(t, a, "GET", "/api/requirements/"+id+"/sessions", nil)
	if code != 200 {
		t.Fatalf("sessions %d: %s", code, raw)
	}
	var result struct {
		Sessions []RequirementSession `json:"sessions"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result.Sessions
}

func TestSessionListIncludesCurrentChatActivityWithoutPersistingIt(t *testing.T) {
	a, q, _, _ := chatFixture(t)
	fakeSessions(a, map[string]codex.Session{"session": {ID: "session", Cwd: q.Members[0].Path}})
	run := &ChatRun{state: ChatState{ID: "run", Status: "running", Busy: true, TurnID: "turn"}}
	a.chats["session"] = run
	// Remove the synthetic run before fixture cleanup tries to stop it.
	defer delete(a.chats, "session")
	for _, status := range []string{"running", "waiting", "stopping"} {
		run.mu.Lock()
		run.state.Status = status
		run.mu.Unlock()
		got := getRequirementSessions(t, a, q.ID)
		if len(got) != 1 || got[0].ChatStatus != status || got[0].CompletedRun != "" {
			t.Fatalf("active session: %+v", got)
		}
	}
	run.mu.Lock()
	run.state.Busy, run.state.Status = false, "completed"
	run.mu.Unlock()
	got := getRequirementSessions(t, a, q.ID)
	if got[0].ChatStatus != "" || got[0].CompletedRun != "run" {
		t.Fatalf("completed session: %+v", got)
	}
	stored, err := a.StoredSessions(q.ID)
	if err != nil || stored[0].ChatStatus != "" || stored[0].CompletedRun != "" {
		t.Fatalf("runtime activity persisted: %+v, %v", stored, err)
	}
	a.openSessions = func(context.Context) (codex.SessionClient, error) { return nil, fmt.Errorf("offline") }
	got = getRequirementSessions(t, a, q.ID)
	if got[0].CompletedRun != "run" {
		t.Fatalf("runtime activity lost on metadata failure: %+v", got)
	}
}

func TestSessionActivityTracksManagedTerminalStatus(t *testing.T) {
	b := &terminalBridge{session: "terminal", connected: true, bound: true}
	a := &Service{bridges: map[string]*terminalBridge{"bridge": b}}
	for _, step := range []struct{ event, want string }{
		{`{"method":"turn/started","params":{"threadId":"terminal"}}`, "running"},
		{`{"method":"thread/status/changed","params":{"threadId":"terminal","status":{"type":"active","activeFlags":["waitingOnUserInput"]}}}`, "waiting"},
		{`{"method":"turn/completed","params":{"threadId":"terminal"}}`, ""},
	} {
		b.observe([]byte(step.event))
		s := RequirementSession{ID: "terminal"}
		a.decorateSessionActivity(&s)
		if s.ChatStatus != step.want {
			t.Fatalf("status = %q, want %q", s.ChatStatus, step.want)
		}
	}
}

func TestSessionsDiscoverPageAndManualLaunchesAndPersistLinks(t *testing.T) {
	a := testApp(t)
	front := register(t, a, "Front", repo(t, "front", "master"))
	back := register(t, a, "Back", repo(t, "back", "master"))
	_, q, _ := create(t, a, front, []string{back}, "sessions")
	_, other, _ := create(t, a, front, nil, "another")
	var plan model.LaunchPlan
	a.Workspace.Launch = func(p model.LaunchPlan, _ func()) error { plan = p; return nil }
	if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/launch", nil); code != 200 {
		t.Fatalf("launch %d %s", code, raw)
	}
	sessions := map[string]codex.Session{
		"page":    {ID: "page", Cwd: plan.Cwd, Name: "页面启动", UpdatedAt: 100},
		"shell":   {ID: "shell", Cwd: plan.AdditionalDirectories[0], Preview: "终端启动", UpdatedAt: 200},
		"outside": {ID: "outside", Cwd: t.TempDir(), Name: "外部会话", UpdatedAt: 300},
		"other":   {ID: "other", Cwd: other.Members[0].Path, Name: "其他任务"},
	}
	fakeSessions(a, sessions)
	got := getRequirementSessions(t, a, q.ID)
	if len(got) != 2 || got[0].ID != "shell" || got[1].ID != "page" || !got[0].Available || got[0].Source != "workspace" {
		t.Fatalf("discovery %+v", got)
	}
	for i := 0; i < 2; i++ {
		if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions", map[string]string{"session_id": "outside"}); code != 200 {
			t.Fatalf("link %d %s", code, raw)
		}
	}
	got = getRequirementSessions(t, a, q.ID)
	if len(got) != 3 || got[0].ID != "outside" || got[0].Source != "manual" {
		t.Fatalf("manual link %+v", got)
	}
	// An unrelated requirement must not inherit these associations.
	if got := getRequirementSessions(t, a, other.ID); len(got) != 1 || got[0].ID != "other" {
		t.Fatalf("cross-requirement association %+v", got)
	}
	reopened, err := openApp(a.Workspace.DataDir, a.Workspace.Root)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Workspace.Store.DB.Close()
	fakeSessions(reopened, sessions)
	got = getRequirementSessions(t, reopened, q.ID)
	if len(got) != 3 || got[0].Source != "manual" {
		t.Fatalf("links lost on restart %+v", got)
	}
	delete(sessions, "outside")
	got = getRequirementSessions(t, reopened, q.ID)
	if len(got) != 3 || got[0].Available || got[0].Error == "" {
		t.Fatalf("missing session not retained %+v", got)
	}
}

func TestSessionResumePreservesOriginalDirectoryAndGuardsWorkspace(t *testing.T) {
	a := testApp(t)
	front := register(t, a, "Front", repo(t, "front", "master"))
	back := register(t, a, "Back", repo(t, "back", "master"))
	_, q, _ := create(t, a, front, []string{back}, "resume")
	path := t.TempDir()
	id := "session'; $(touch UNEXPECTED)"
	sessions := map[string]codex.Session{id: {ID: id, Cwd: path, Name: "Manual"}}
	fakeSessions(a, sessions)
	launches := 0
	var plan model.LaunchPlan
	a.Workspace.Launch = func(p model.LaunchPlan, _ func()) error { launches++; plan = p; return nil }
	endpoint := "/api/requirements/" + q.ID + "/sessions/" + strings.ReplaceAll(strings.ReplaceAll(id, " ", "%20"), "'", "%27") + "/resume"
	if code, _ := call(t, a, "POST", endpoint, nil); code != 404 {
		t.Fatalf("unlinked session accepted %d", code)
	}
	if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions", map[string]string{"session_id": id}); code != 200 {
		t.Fatalf("link %d %s", code, raw)
	}
	if code, raw := call(t, a, "POST", endpoint, nil); code != 200 {
		t.Fatalf("resume %d %s", code, raw)
	}
	wantArgs := []string{"resume", id, "--cd", path}
	if runtime.GOOS == "linux" {
		if len(plan.Args) != 6 || plan.Args[4] != "--remote" || !strings.HasPrefix(plan.Args[5], "unix://") {
			t.Fatalf("missing managed terminal relay: %+v", plan)
		}
		wantArgs = append(wantArgs, plan.Args[4:]...)
	} else {
		for _, dir := range plan.AdditionalDirectories {
			wantArgs = append(wantArgs, "--add-dir", dir)
		}
		if a.TerminalOwner(id, path) != nil {
			t.Fatal("native launcher reserved an unsupported managed relay")
		}
	}
	if plan.Cwd != path || len(plan.AdditionalDirectories) != 2 || !reflect.DeepEqual(plan.Args, wantArgs) {
		t.Fatalf("resume plan %+v", plan)
	}
	if err := exec.Command("bash", "-n", plan.Script).Run(); err != nil {
		t.Fatal(err)
	}
	// Parse the command with a shell but replace Codex with a harmless argument
	// printer, checking that session IDs and directories arrive literally.
	output, err := exec.Command("bash", "-c", "codex() { printf '%s\\0' \"$@\"; }; "+plan.Command).Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Split(strings.TrimSuffix(string(output), "\x00"), "\x00"); !reflect.DeepEqual(got, plan.Args) {
		t.Fatalf("shell changed arguments: %q", got)
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	if code, _ := call(t, a, "POST", endpoint, nil); code != 409 || launches != 1 {
		t.Fatalf("missing directory launched: %d %d", code, launches)
	}
	if err := os.Mkdir(path, 0700); err != nil {
		t.Fatal(err)
	}
	testGit(t, q.Members[0].Path, "switch", "-c", "drift")
	if code, _ := call(t, a, "POST", endpoint, nil); code != 409 || launches != 1 {
		t.Fatalf("branch drift launched: %d %d", code, launches)
	}
}

func TestSessionPaginationAndPickerSearch(t *testing.T) {
	a := testApp(t)
	p := register(t, a, "Repo", repo(t, "repo", "master"))
	_, q, _ := create(t, a, p, nil, "pages")
	requests := 0
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, params map[string]any) (any, error) {
			if method != "thread/list" {
				return nil, fmt.Errorf("unexpected read")
			}
			if !reflect.DeepEqual(params["sourceKinds"], []string{"cli", "vscode", "appServer"}) {
				t.Fatal(params)
			}
			if params["cwd"] == nil {
				if params["cursor"] != "opaque" || params["searchTerm"] != "test title" {
					t.Fatal(params)
				}
				return codex.SessionPage{Data: []codex.Session{{ID: "picker", Preview: strings.Repeat("x", 500), Cwd: "/tmp"}}}, nil
			}
			requests++
			if params["cursor"] == nil {
				next := "page2"
				return codex.SessionPage{Data: []codex.Session{{ID: "one", Cwd: q.Members[0].Path}}, NextCursor: &next}, nil
			}
			return codex.SessionPage{Data: []codex.Session{{ID: "two", Cwd: q.Path}, {ID: "foreign", Cwd: q.Path + "-other"}}}, nil
		}}, nil
	}
	if got := getRequirementSessions(t, a, q.ID); len(got) != 2 || requests != 2 {
		t.Fatalf("pagination %+v %d", got, requests)
	}
	code, raw := call(t, a, "GET", "/api/codex/sessions?cursor=opaque&search=test%20title", nil)
	if code != 200 || strings.Contains(string(raw), strings.Repeat("x", 161)) {
		t.Fatalf("picker %d %s", code, raw)
	}
}

func TestSessionErrorsAreVisibleAndDoNotLaunch(t *testing.T) {
	a := testApp(t)
	p := register(t, a, "Repo", repo(t, "repo", "master"))
	_, q, _ := create(t, a, p, nil, "errors")
	a.openSessions = func(context.Context) (codex.SessionClient, error) { return nil, fmt.Errorf("Codex unavailable") }
	if code, raw := call(t, a, "GET", "/api/codex/sessions", nil); code != 503 || !strings.Contains(string(raw), "Codex unavailable") {
		t.Fatalf("%d %s", code, raw)
	}
	if err := a.SaveSession(q.ID, codex.Session{ID: "cached", Cwd: q.Path, Name: "Saved session"}, "manual"); err != nil {
		t.Fatal(err)
	}
	if code, raw := call(t, a, "GET", "/api/requirements/"+q.ID+"/sessions", nil); code != 200 || !strings.Contains(string(raw), "Codex unavailable") || !strings.Contains(string(raw), "Saved session") || !strings.Contains(string(raw), `"available":false`) {
		t.Fatalf("%d %s", code, raw)
	}
	if code, _ := call(t, a, "GET", "/api/requirements/missing/sessions", nil); code != 404 {
		t.Fatal(code)
	}
	if code, _ := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions", map[string]string{"session_id": ""}); code != 400 {
		t.Fatal(code)
	}
}

// Optional compatibility smoke check against the installed CLI. This only
// lists and reads saved records; it never resumes a session or starts an agent turn.
func TestInstalledCodexSessionProtocol(t *testing.T) {
	if os.Getenv("WORKTREE_HUB_TEST_INSTALLED_CODEX") != "1" {
		t.Skip("opt-in installed CLI compatibility check")
	}
	c, err := codex.OpenSessionClient(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	page, err := sessionList(c, map[string]any{})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Data) > 0 {
		s, err := readSession(c, page.Data[0].ID)
		if err != nil || s.ID != page.Data[0].ID || !filepath.IsAbs(s.Cwd) {
			t.Fatalf("metadata read failed: %v", err)
		}
		if _, err := readSessionHistory(c, s, ""); err != nil {
			t.Fatalf("saved history read failed: %v", err)
		}
	}
	page, err = sessionList(c, map[string]any{"cwd": []string{filepath.Join(t.TempDir(), "no-sessions")}})
	if err != nil || len(page.Data) != 0 {
		t.Fatalf("directory filter failed: %v", err)
	}
}
