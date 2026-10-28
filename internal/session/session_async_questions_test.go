package session

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"worktree-hub/internal/codex"
)

func asyncQuestionItem() map[string]any {
	return map[string]any{"id": "async-question", "type": "agentMessage", "delivery": "async", "text": "请选择迁移范围", "questions": []any{
		map[string]any{"title": "迁移范围？", "options": []string{"保留兼容（推荐）", "移除兼容"}},
		map[string]any{"title": "还有什么要求？"},
	}}
}

func emitAsyncQuestion(t *testing.T, a *App, c *fakeLiveClient) ChatState {
	t.Helper()
	c.event("item/completed", map[string]any{"turnId": "turn", "item": asyncQuestionItem()})
	return awaitChat(t, a, func(s ChatState) bool { return len(s.Entries) > 0 && len(s.Entries[0].Questions) == 2 })
}

func asyncAnswer() map[string]any {
	return map[string]any{"item_id": "async-question", "turn_id": "turn", "decision": "accept", "answers": map[string][]string{"0": {"保留兼容（推荐）\n\n保留历史数据"}, "1": {"覆盖所有项目"}}}
}

func asyncHistory(a *App, cwd string, laterUser bool) {
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, params map[string]any) (any, error) {
			switch method {
			case "thread/read":
				return map[string]any{"thread": map[string]any{"id": "session", "cwd": cwd, "historyMode": "paginated"}}, nil
			case "thread/items/list":
				data := []any{map[string]any{"turnId": "turn", "item": asyncQuestionItem()}}
				if laterUser {
					data = append([]any{map[string]any{"turnId": "next", "item": map[string]any{"id": "manual-answer", "type": "userMessage", "content": chatTurnInput("已在原生 Codex 回答", nil)}}}, data...)
				}
				return map[string]any{"data": data}, nil
			}
			return nil, fmt.Errorf("unexpected method %s", method)
		}}, nil
	}
}

type asyncAnswerClient struct {
	*fakeLiveClient
	steers []map[string]any
	fail   bool
}

func (c *asyncAnswerClient) Call(ctx context.Context, method string, params any, out any) error {
	if method == "turn/steer" {
		c.steers = append(c.steers, params.(map[string]any))
		if c.fail {
			return fmt.Errorf("lost acknowledgement")
		}
		raw, _ := json.Marshal(map[string]any{"turnId": "turn"})
		return json.Unmarshal(raw, out)
	}
	return c.fakeLiveClient.Call(ctx, method, params, out)
}

func TestAsyncQuestionRunningSubmissionIsDurableAndIdempotent(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(fmt.Sprint(fail), func(t *testing.T) {
			a, _, c, endpoint := chatFixture(t)
			client := &asyncAnswerClient{fakeLiveClient: c, fail: fail}
			a.openLive = func(context.Context) (codex.LiveClient, error) { return client, nil }
			startFakeChat(t, a, endpoint)
			s := emitAsyncQuestion(t, a, c)
			if s.Status != "running" || len(s.Approvals) != 0 || s.Entries[0].Questions[0].Options[1].Label != "移除兼容" {
				t.Fatal(s)
			}
			body := asyncAnswer()
			body["answers"] = map[string][]string{"0": {"保留兼容"}}
			if code, _ := call(t, a, "POST", endpoint+"/question", body); code != 400 {
				t.Fatal("incomplete answers accepted", code)
			}
			want := 200
			if fail {
				want = 409
			}
			for i := 0; i < 2; i++ {
				if code, raw := call(t, a, "POST", endpoint+"/question", asyncAnswer()); code != want {
					t.Fatalf("%d %s", code, raw)
				}
			}
			if len(client.steers) != 1 || client.steers[0]["expectedTurnId"] != "turn" {
				t.Fatal(client.steers)
			}
			input, _ := json.Marshal(client.steers[0]["input"])
			if !strings.Contains(string(input), "保留历史数据") || !strings.Contains(string(input), "还有什么要求？") {
				t.Fatal(string(input))
			}
			code, raw := call(t, a, "GET", endpoint, nil)
			var restored ChatState
			if err := json.Unmarshal(raw, &restored); err != nil || code != 200 {
				t.Fatalf("%d %s", code, raw)
			}
			status := "accepted"
			if fail {
				status = "pending"
			}
			if restored.Entries[0].QuestionStatus != status {
				t.Fatal(restored)
			}
			if len(c.replies) != 0 {
				t.Fatal("async answer used blocking approval RPC", c.replies)
			}
			c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
			awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
		})
	}
}

func TestAsyncQuestionAfterCompletionStartsNextTurnAndSkipPersists(t *testing.T) {
	for _, decision := range []string{"accept", "decline"} {
		t.Run(decision, func(t *testing.T) {
			a, _, c, endpoint := chatFixture(t)
			startFakeChat(t, a, endpoint)
			emitAsyncQuestion(t, a, c)
			c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
			awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
			asyncHistory(a, c.cwd, false)
			body := asyncAnswer()
			body["decision"] = decision
			if code, raw := call(t, a, "POST", endpoint+"/question", body); code != 200 {
				t.Fatalf("%d %s", code, raw)
			}
			if code, raw := call(t, a, "POST", endpoint+"/question", body); code != 200 {
				t.Fatalf("retry %d %s", code, raw)
			}
			c.mu.Lock()
			starts := 0
			for _, method := range c.methods {
				if method == "turn/start" {
					starts++
				}
			}
			params := c.startParams
			c.mu.Unlock()
			want := 1
			if decision == "accept" {
				want = 2
			}
			if starts != want {
				t.Fatal("duplicated or missing next turn", starts)
			}
			if decision == "accept" {
				if !strings.HasPrefix(params["clientUserMessageId"].(string), "async-") {
					t.Fatal(params)
				}
				c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
				awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
			}
			// A new service has no in-memory runs. Receipts survive independently.
			reopened := New(a.Workspace, a.Tasks)
			entries := []HistoryEntry{{ID: "async-question", TurnID: "turn", Delivery: "async", Questions: []ChatQuestion{{ID: "0"}}}}
			if err := reopened.decorateAsyncQuestions("session", entries); err != nil {
				t.Fatal(err)
			}
			wantStatus := "accepted"
			if decision == "decline" {
				wantStatus = "skipped"
			}
			if entries[0].QuestionStatus != wantStatus {
				t.Fatal(entries)
			}
			fresh := &App{Service: reopened, Projects: a.Projects, Tasks: a.Tasks, token: a.token}
			asyncHistory(fresh, c.cwd, false)
			code, raw := call(t, fresh, "GET", "/api/sessions/session/history", nil)
			var history SessionHistory
			if err := json.Unmarshal(raw, &history); err != nil || code != 200 || len(history.Entries) != 1 || history.Entries[0].QuestionStatus != wantStatus || len(history.Entries[0].Questions) != 2 {
				t.Fatalf("restored history %d %s", code, raw)
			}
		})
	}
}

func TestAsyncQuestionAnsweredElsewhereCannotBeResubmittedFromACompletedSnapshot(t *testing.T) {
	a, _, c, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	emitAsyncQuestion(t, a, c)
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	asyncHistory(a, c.cwd, true)
	if code, raw := call(t, a, "POST", endpoint+"/question", asyncAnswer()); code != 409 || !strings.Contains(string(raw), "后续消息") {
		t.Fatalf("%d %s", code, raw)
	}
	var count int
	if err := a.Workspace.Store.DB.QueryRow(`SELECT count(*) FROM conversation_async_answers`).Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
	}
}

func TestAsyncQuestionsRestoreFromOlderHistoryPage(t *testing.T) {
	a, _, c, _ := chatFixture(t)
	a.openSessions = func(context.Context) (codex.SessionClient, error) {
		return &fakeSessionClient{request: func(method string, params map[string]any) (any, error) {
			switch method {
			case "thread/read":
				return map[string]any{"thread": map[string]any{"id": "session", "cwd": c.cwd, "historyMode": "paginated"}}, nil
			case "thread/items/list":
				if params["cursor"] == "older" {
					return map[string]any{"data": []any{map[string]any{"turnId": "turn", "item": asyncQuestionItem()}}}, nil
				}
				return map[string]any{"nextCursor": "older", "data": []any{map[string]any{"turnId": "turn", "item": map[string]any{"id": "latest", "type": "agentMessage", "text": "继续检查"}}}}, nil
			}
			return nil, fmt.Errorf("unexpected method %s", method)
		}}, nil
	}
	e, err := a.pendingAsyncQuestion(context.Background(), "session", "async-question", "turn")
	if err != nil || len(e.Questions) != 2 || e.Questions[0].ID != "0" || !e.Questions[0].IsOther {
		t.Fatal(e, err)
	}
	if _, err = a.pendingAsyncQuestion(context.Background(), "session", "forged", "turn"); err == nil {
		t.Fatal("accepted an unknown question")
	}
}
