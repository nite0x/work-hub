package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"

	"worktree-hub/internal/codex"
)

func historyEvent(sequence uint64, method, session string, params map[string]any) codex.Event {
	params["threadId"] = session
	raw, _ := json.Marshal(params)
	return codex.Event{Sequence: sequence, Method: method, Params: raw}
}

func TestHistoryPushFiltersAndAccumulatesVisibleOutput(t *testing.T) {
	s := HistoryPush{Entries: []HistoryEntry{}}
	apply := func(method string, p map[string]any) bool {
		return s.apply("session", historyEvent(1, method, "session", p))
	}
	apply("item/started", map[string]any{"turnId": "turn", "item": map[string]any{"id": "reply", "type": "agentMessage", "text": "first "}})
	apply("item/agentMessage/delta", map[string]any{"turnId": "turn", "itemId": "reply", "delta": "实时回复"})
	apply("item/started", map[string]any{"turnId": "turn", "item": map[string]any{"id": "cmd", "type": "commandExecution", "command": "test", "status": "inProgress"}})
	apply("item/commandExecution/outputDelta", map[string]any{"turnId": "turn", "itemId": "cmd", "delta": "one\n"})
	apply("item/commandExecution/outputDelta", map[string]any{"turnId": "turn", "itemId": "cmd", "delta": "two\n"})
	apply("item/completed", map[string]any{"turnId": "turn", "item": map[string]any{"id": "cmd", "type": "commandExecution", "command": "test", "status": "completed", "exitCode": 0}})
	if len(s.Entries) != 2 || s.Entries[0].Text != "first 实时回复" || *s.Entries[1].Output != "one\ntwo\n" || *s.Entries[1].ExitCode != 0 {
		t.Fatal(s)
	}
	if apply("item/reasoning/textDelta", map[string]any{"delta": "PRIVATE"}) || apply("item/started", map[string]any{"item": map[string]any{"type": "reasoning"}}) {
		t.Fatal("private events forwarded")
	}
	if s.apply("session", historyEvent(1, "item/agentMessage/delta", "other", map[string]any{"delta": "PRIVATE"})) {
		t.Fatal("cross-thread event forwarded")
	}
	apply("turn/completed", map[string]any{})
	if s.Sync != 1 {
		t.Fatal("missing history resync")
	}
	apply("item/commandExecution/outputDelta", map[string]any{"turnId": "turn", "itemId": "cmd", "delta": strings.Repeat("x", 300<<10)})
	if len(*s.Entries[1].Output) > 270<<10 {
		t.Fatal("unbounded preview")
	}
}

type fakeHistoryObserver struct {
	updates chan codex.Event
	methods []string
	params  []map[string]any
	loaded  bool
	waiting bool
	replies int
}

func (c *fakeHistoryObserver) Close()                           {}
func (c *fakeHistoryObserver) Events() <-chan codex.Event       { return c.updates }
func (c *fakeHistoryObserver) Reply(json.RawMessage, any) error { c.replies++; return nil }
func (c *fakeHistoryObserver) Call(ctx context.Context, method string, params any, result any) error {
	_, err := c.CallOrdered(ctx, method, params, result)
	return err
}
func (c *fakeHistoryObserver) CallOrdered(ctx context.Context, method string, params any, result any) (uint64, error) {
	c.methods = append(c.methods, method)
	c.params = append(c.params, params.(map[string]any))
	value := any(map[string]any{})
	switch method {
	case "thread/read":
		status := "notLoaded"
		if c.loaded {
			status = "active"
		}
		value = map[string]any{"thread": map[string]any{"status": map[string]any{"type": status}}}
	case "thread/resume":
		value = map[string]any{"initialTurnsPage": map[string]any{"data": []any{map[string]any{"id": "turn", "status": "inProgress", "items": []any{map[string]any{"id": "reply", "type": "agentMessage", "text": "prefix"}}}}}}
		if c.waiting {
			value.(map[string]any)["thread"] = map[string]any{"status": map[string]any{"type": "active", "activeFlags": []string{"waitingOnUserInput"}}}
		}
	case "thread/unsubscribe":
	default:
		return 0, fmt.Errorf("unexpected mutating method: %s", method)
	}
	if result != nil {
		raw, _ := json.Marshal(value)
		return 10, json.Unmarshal(raw, result)
	}
	return 10, nil
}

func TestHistoryObserverSnapshotBoundaryAndTerminalOwnership(t *testing.T) {
	c := &fakeHistoryObserver{updates: make(chan codex.Event, 8), loaded: true}
	c.updates <- historyEvent(9, "item/agentMessage/delta", "session", map[string]any{"turnId": "turn", "itemId": "reply", "delta": "prefix"})
	approval := historyEvent(11, "item/commandExecution/requestApproval", "session", map[string]any{})
	approval.ID = json.RawMessage(`"terminal-approval"`)
	c.updates <- approval
	c.updates <- historyEvent(12, "item/agentMessage/delta", "session", map[string]any{"turnId": "turn", "itemId": "reply", "delta": " suffix"})
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	seen := false
	err := observeHistory(ctx, c, "session", func(s HistoryPush) error {
		if len(s.Entries) > 0 && s.Entries[0].Text == "prefix suffix" {
			seen = true
			cancel()
		}
		return nil
	})
	if err != context.Canceled || !seen || c.replies != 0 {
		t.Fatal(err, seen, c.replies)
	}
	if strings.Join(c.methods, ",") != "thread/read,thread/resume,thread/unsubscribe" {
		t.Fatal(c.methods)
	}
	params := c.params[1]
	if len(params) != 3 || params["threadId"] != "session" || params["excludeTurns"] != true {
		t.Fatal("unexpected configuration override", params)
	}
}

func TestHistoryObserverDoesNotLoadInactiveThread(t *testing.T) {
	c := &fakeHistoryObserver{updates: make(chan codex.Event)}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_ = observeHistory(ctx, c, "session", func(HistoryPush) error { return nil })
	if strings.Join(c.methods, ",") != "thread/read" {
		t.Fatal("inactive thread resumed", c.methods)
	}
}

func TestHistoryPushShowsQuestionsAndClearsResolvedConfirmations(t *testing.T) {
	s := HistoryPush{Entries: []HistoryEntry{{ID: "cmd", TurnID: "turn", Kind: "command", Command: "go test ./...", Cwd: "/workspace"}}}
	command := historyEvent(1, "item/commandExecution/requestApproval", "session", map[string]any{"turnId": "turn", "itemId": "cmd", "reason": "测试需要访问目录"})
	command.ID = json.RawMessage(`7`)
	question := historyEvent(2, "item/tool/requestUserInput", "session", map[string]any{"turnId": "turn", "questions": []any{map[string]any{"id": "choice", "header": "方案", "question": "选择哪种方式？", "options": []any{map[string]any{"label": "方案 A", "description": "优先兼容"}}}}})
	question.ID = json.RawMessage(`"question"`)
	if !s.apply("session", command) || !s.apply("session", question) || !s.apply("session", question) {
		t.Fatal("confirmation event ignored")
	}
	if len(s.Confirmations) != 2 || !strings.Contains(s.Confirmations[0].Details, "go test ./...") || s.Confirmations[1].Questions[0].Options[0].Label != "方案 A" {
		t.Fatal(s.Confirmations)
	}
	resolved := historyEvent(3, "serverRequest/resolved", "session", map[string]any{"requestId": 7})
	s.apply("session", resolved)
	if len(s.Confirmations) != 1 || s.Confirmations[0].ID != `"question"` {
		t.Fatal(s.Confirmations)
	}
	s.apply("session", historyEvent(4, "thread/status/changed", "session", map[string]any{"status": map[string]any{"type": "active", "activeFlags": []string{"waitingOnUserInput"}}}))
	if !s.Waiting {
		t.Fatal("missing waiting status")
	}
	s.apply("session", historyEvent(5, "serverRequest/resolved", "session", map[string]any{"requestId": "question"}))
	if len(s.Confirmations) != 0 || s.Waiting {
		t.Fatal("resolved confirmation retained")
	}
	s.apply("session", question)
	s.apply("session", historyEvent(6, "turn/completed", "session", map[string]any{}))
	if len(s.Confirmations) != 0 {
		t.Fatal("completed turn retained confirmations")
	}
	other := question
	other.Params = historyEvent(7, question.Method, "other", map[string]any{}).Params
	if s.apply("session", other) {
		t.Fatal("cross-thread confirmation displayed")
	}
	unknown := historyEvent(8, "item/tool/call", "session", map[string]any{"arguments": "PRIVATE_ARGUMENTS"})
	unknown.ID = json.RawMessage(`99`)
	if s.apply("session", unknown) {
		t.Fatal("non-confirmation RPC displayed")
	}
	s.apply("session", question)
	raw, _ := json.Marshal(s)
	if strings.Contains(string(raw), "can_accept") || strings.Contains(string(raw), "rpcID") || strings.Contains(string(raw), "PRIVATE_ARGUMENTS") {
		t.Fatal("control data crossed display boundary")
	}
}

func TestHistoryObserverShowsReplayedQuestionsAndExistingWaitingStatus(t *testing.T) {
	for _, replay := range []bool{false, true} {
		t.Run(fmt.Sprint("replay=", replay), func(t *testing.T) {
			c := &fakeHistoryObserver{updates: make(chan codex.Event, 2), loaded: true, waiting: !replay}
			if replay {
				event := historyEvent(9, "item/tool/requestUserInput", "session", map[string]any{"questions": []any{map[string]any{"id": "q", "question": "继续吗？"}}})
				event.ID = json.RawMessage(`"pending"`)
				c.updates <- event
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			seen := false
			_ = observeHistory(ctx, c, "session", func(state HistoryPush) error {
				if state.Connected && (state.Waiting || len(state.Confirmations) > 0) {
					seen = true
					cancel()
				}
				return nil
			})
			if !seen || c.replies != 0 {
				t.Fatal("waiting question missing or answered by observer", seen, c.replies)
			}
		})
	}
}

func TestHistoryEventsAreScopedAndAvailableInReadOnlyMode(t *testing.T) {
	a := testApp(t)
	p := register(t, a, "Repo", repo(t, "repo", "master"))
	_, q, _ := create(t, a, p, nil, "push")
	if err := a.SaveSession(q.ID, codex.Session{ID: "linked", Cwd: q.Path}, "manual"); err != nil {
		t.Fatal(err)
	}
	a.Workspace.ReadOnlySessions = true
	calls := 0
	a.watchHistory = func(ctx context.Context, id string, emit func(HistoryPush) error) error {
		calls++
		if id != "linked" {
			t.Fatal(id)
		}
		return emit(HistoryPush{Connected: true, Entries: []HistoryEntry{{ID: "r", TurnID: "t", Kind: "assistant", Text: "live"}}})
	}
	endpoint := "/api/requirements/" + q.ID + "/sessions/linked/history/events"
	if code, raw := call(t, a, "GET", endpoint, nil); code != 200 || !strings.Contains(string(raw), `"text":"live"`) {
		t.Fatalf("%d %s", code, raw)
	}
	if code, _ := call(t, a, "GET", strings.Replace(endpoint, "linked", "unlinked", 1), nil); code != 404 || calls != 1 {
		t.Fatal("unassociated thread watched", code, calls)
	}
	r := httptest.NewRequest(http.MethodGet, endpoint, nil)
	w := httptest.NewRecorder()
	a.handler().ServeHTTP(w, r)
	if w.Code != 403 || calls != 1 {
		t.Fatal("unauthenticated subscription accepted")
	}
}

// Read-only observer smoke test, using a disposable thread and harmless shell
// commands. No model turn or existing user thread is used.
func TestInstalledCodexHistoryPush(t *testing.T) {
	testInstalledHistoryPush(t, false)
}

func TestInstalledCodexWorkspaceHistoryPush(t *testing.T) {
	testInstalledHistoryPush(t, true)
}

func testInstalledHistoryPush(t *testing.T, remote bool) {
	t.Helper()
	if os.Getenv("WORKTREE_HUB_TEST_INSTALLED_CODEX") != "1" {
		t.Skip("opt-in local protocol check")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	owner, err := openHistoryObserver(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer owner.Close()
	var started struct {
		Thread struct {
			ID string `json:"id"`
		} `json:"thread"`
	}
	if err := owner.Call(ctx, "thread/start", map[string]any{"cwd": t.TempDir(), "sandbox": "read-only", "approvalPolicy": "never"}, &started); err != nil {
		t.Fatal(err)
	}
	defer func() {
		cleanup, done := context.WithTimeout(context.Background(), 5*time.Second)
		defer done()
		_ = owner.Call(cleanup, "thread/delete", map[string]any{"threadId": started.Thread.ID}, nil)
	}()
	seedCommand, outputCommand := "printf PUSH_SEED", "printf PUSH_FIRST; sleep 1; printf PUSH_SECOND"
	if runtime.GOOS == "windows" {
		seedCommand, outputCommand = "Write-Output PUSH_SEED", "Write-Output PUSH_FIRST; Start-Sleep -Seconds 1; Write-Output PUSH_SECOND"
	}
	if err := owner.Call(ctx, "thread/shellCommand", map[string]any{"threadId": started.Thread.ID, "command": seedCommand, "timeoutMs": 5000}, nil); err != nil {
		t.Fatal(err)
	}
	seeded := false
	for !seeded {
		select {
		case event := <-owner.Events():
			seeded = event.Method == "item/completed"
		case <-ctx.Done():
			t.Fatal("seed command did not finish")
		}
	}
	observer, err := openHistoryObserver(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer observer.Close()
	watch := func(ctx context.Context, session string, emit func(HistoryPush) error) error {
		return observeHistory(ctx, observer, session, emit)
	}
	if remote {
		client := testWorkspaceClient(t)
		watch = func(ctx context.Context, id string, emit func(HistoryPush) error) error {
			return watchRemoteHistory(ctx, client, id, emit)
		}
	}
	ready := make(chan struct{})
	result := make(chan error, 1)
	go func() {
		announced := false
		result <- watch(ctx, started.Thread.ID, func(state HistoryPush) error {
			if state.Connected && !announced {
				close(ready)
				announced = true
			}
			for _, entry := range state.Entries {
				if entry.Output != nil && strings.Contains(*entry.Output, "PUSH_FIRST") && entry.Status == "inProgress" {
					return fmt.Errorf("incremental-output-seen")
				}
			}
			return nil
		})
	}()
	select {
	case <-ready:
	case err := <-result:
		t.Fatal(err)
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	if err := owner.Call(ctx, "thread/shellCommand", map[string]any{"threadId": started.Thread.ID, "command": outputCommand, "timeoutMs": 5000}, nil); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-result:
		if err == nil || err.Error() != "incremental-output-seen" {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("command output was not pushed before completion", ctx.Err())
	}
}
