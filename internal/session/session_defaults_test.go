package session

import (
	"testing"
)

func TestNewConversationDefaultModelEffortAndPermission(t *testing.T) {
	a, q, c, _ := chatFixture(t)
	if code, raw := call(t, a, "POST", "/api/requirements/"+q.ID+"/sessions/new", map[string]string{"text": "检查默认设置", "request_id": "defaults"}); code != 202 {
		t.Fatalf("%d %s", code, raw)
	}
	state := awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
	c.mu.Lock()
	start, turn := c.threadParams["thread/start"], c.startParams
	if start["model"] != "gpt-6.1-sol" || start["sandbox"] != "danger-full-access" || start["approvalPolicy"] != "never" || start["config"].(map[string]any)["model_reasoning_effort"] != "high" {
		t.Error(start)
	}
	if turn["model"] != "gpt-6.1-sol" || turn["effort"] != "high" || turn["sandboxPolicy"].(map[string]any)["type"] != "dangerFullAccess" || turn["approvalPolicy"] != "never" {
		t.Error(turn)
	}
	c.mu.Unlock()
	if state.Context == nil || state.Context.Model != "gpt-6.1-sol" || state.Context.Effort != "high" || state.Context.Sandbox.(map[string]any)["type"] != "dangerFullAccess" {
		t.Fatal(state.Context)
	}
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitTitleFinished(t, a)
}

func TestNewConversationDefaultsPreserveExplicitChoices(t *testing.T) {
	custom := TurnSettings{Model: "another-model", Effort: "low", Permission: "ask", Mode: "plan"}
	if got := newConversationSettings(custom); got != custom {
		t.Fatal(got)
	}
	if got := newConversationSettings(TurnSettings{Model: "another-model"}); got.Model != "another-model" || got.Effort != "" || got.Permission != "full" {
		t.Fatal(got)
	}
	if got := newConversationSettings(TurnSettings{Effort: "medium", Permission: "auto"}); got.Model != "gpt-6.1-sol" || got.Effort != "medium" || got.Permission != "auto" {
		t.Fatal(got)
	}
}
