package session

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

func lastApprovalReply(t *testing.T, c *fakeLiveClient) map[string]any {
	t.Helper()
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.replies) == 0 {
		t.Fatal("no RPC reply")
	}
	var reply map[string]any
	if err := json.Unmarshal([]byte(strings.SplitN(c.replies[len(c.replies)-1], ":", 2)[1]), &reply); err != nil {
		t.Fatal(err)
	}
	return reply
}

func TestMCPToolApprovalRoundTripsOfferedScopes(t *testing.T) {
	for _, decision := range []string{"accept", "accept_session", "accept_always", "decline", "cancel"} {
		t.Run(decision, func(t *testing.T) {
			a, _, c, endpoint := chatFixture(t)
			startFakeChat(t, a, endpoint)
			c.request("mcpServer/elicitation/request", "mcp", map[string]any{
				"serverName": "apix", "mode": "form", "message": `Allow the apix MCP server to run tool "list_mcp_servers"?`,
				"requestedSchema": map[string]any{"type": "object", "properties": map[string]any{}},
				"_meta":           map[string]any{"codex_approval_kind": "mcp_tool_call", "persist": []string{"session", "always"}},
			})
			s := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
			approval := s.Approvals[0]
			if !approval.CanAccept || approval.Elicitation.ServerName != "apix" || !strings.Contains(approval.Details, "list_mcp_servers") || len(approval.Choices) != 5 {
				t.Fatal(approval)
			}
			body := map[string]any{"run_id": s.ID, "approval_id": approval.ID, "decision": decision, "content": map[string]any{"draft": "DO_NOT_SEND_ON_REJECT"}}
			if strings.HasPrefix(decision, "accept") {
				body["content"] = map[string]any{}
			}
			if code, raw := call(t, a, "POST", endpoint+"/approval", body); code != 200 {
				t.Fatalf("%d %s", code, raw)
			}
			reply := lastApprovalReply(t, c)
			wantAction := decision
			if strings.HasPrefix(decision, "accept") {
				wantAction = "accept"
			}
			if reply["action"] != wantAction {
				t.Fatal(reply)
			}
			if decision == "accept_session" || decision == "accept_always" {
				if reply["_meta"].(map[string]any)["persist"] != strings.TrimPrefix(decision, "accept_") {
					t.Fatal(reply)
				}
			} else if decision == "cancel" {
				if reply["_meta"].(map[string]any)["codex_approval_cancellation_reason"] != "user" {
					t.Fatal(reply)
				}
			} else if _, exists := reply["_meta"]; exists {
				t.Fatal(reply)
			}
			if (decision == "decline" || decision == "cancel") && reply["content"] != nil {
				t.Fatal("rejected draft leaked", reply)
			}
			if code, _ := call(t, a, "POST", endpoint+"/approval", body); code != 409 {
				t.Fatal("duplicate accepted", code)
			}
		})
	}
}

func TestMCPFormValidatesTypesConstraintsAndOriginalEnumValues(t *testing.T) {
	a, _, c, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	var schema any
	_ = json.Unmarshal([]byte(`{"type":"object","additionalProperties":false,"required":["name","count","ratio","enabled","choice","tags","email"],"properties":{
		"name":{"type":"string","minLength":2,"maxLength":5},
		"count":{"type":"integer","minimum":1,"maximum":5},"ratio":{"type":"number"},
		"enabled":{"type":"boolean","default":false},
		"choice":{"type":"string","oneOf":[{"const":"id-a","title":"选项 A"},{"const":"id-b","title":"选项 B"}]},
		"tags":{"type":"array","minItems":1,"maxItems":2,"uniqueItems":true,"items":{"enum":["x","y"],"type":"string"}},
		"email":{"type":"string","format":"email"}}}`), &schema)
	c.request("mcpServer/elicitation/request", 12, map[string]any{"serverName": "form-tool", "mode": "form", "message": "填写测试配置", "requestedSchema": schema})
	s := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
	approval := s.Approvals[0]
	if !approval.CanAccept || approval.Elicitation.JSONFallback || len(approval.Elicitation.Fields) != 7 {
		t.Fatal(approval)
	}
	for _, f := range approval.Elicitation.Fields {
		if f.Name == "choice" && (f.Options[0].Value != "id-a" || f.Options[0].Label != "选项 A") {
			t.Fatal(f)
		}
	}
	valid := map[string]any{"name": "配置", "count": 2, "ratio": 1.5, "enabled": false, "choice": "id-b", "tags": []string{"x"}, "email": "test@example.com"}
	for _, invalid := range []struct {
		key   string
		value any
	}{
		{"count", 2.5}, {"count", 6}, {"enabled", "false"}, {"choice", "选项 B"}, {"tags", []string{}}, {"tags", []string{"x", "x"}}, {"name", "太长的配置名称"}, {"email", "invalid"}, {"extra", "unexpected"},
	} {
		content := map[string]any{}
		for key, value := range valid {
			content[key] = value
		}
		content[invalid.key] = invalid.value
		if code, _ := call(t, a, "POST", endpoint+"/approval", map[string]any{"run_id": s.ID, "approval_id": approval.ID, "decision": "accept", "content": content}); code != 400 {
			t.Fatalf("invalid %s accepted: %d", invalid.key, code)
		}
	}
	for _, decision := range []string{"accept_session", "accept_always", "unknown"} {
		if code, _ := call(t, a, "POST", endpoint+"/approval", map[string]any{"run_id": s.ID, "approval_id": approval.ID, "decision": decision, "content": valid}); code != 400 {
			t.Fatal("unoffered choice accepted", decision, code)
		}
	}
	if code, _ := call(t, a, "POST", endpoint+"/approval", map[string]any{"run_id": s.ID, "approval_id": approval.ID, "decision": "accept"}); code != 400 {
		t.Fatal("missing required fields accepted")
	}
	c.mu.Lock()
	count := len(c.replies)
	c.mu.Unlock()
	if count != 0 || len(a.ChatFor("session").snapshot().Approvals) != 1 {
		t.Fatal("invalid submission resolved the request")
	}
	if code, raw := call(t, a, "POST", endpoint+"/approval", map[string]any{"run_id": s.ID, "approval_id": approval.ID, "decision": "accept", "content": valid}); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	reply := lastApprovalReply(t, c)
	raw, _ := json.Marshal(valid)
	var expected any
	_ = json.Unmarshal(raw, &expected)
	if !reflect.DeepEqual(reply["content"], expected) {
		t.Fatal(reply)
	}
}

func TestMCPExtendedFormsAndURLInteractions(t *testing.T) {
	for _, mode := range []string{"openai/form", "openaiForm"} {
		t.Run(mode, func(t *testing.T) {
			a, _, c, endpoint := chatFixture(t)
			startFakeChat(t, a, endpoint)
			var schema any
			_ = json.Unmarshal([]byte(`{"type":"object","required":["config"],"properties":{"config":{"$ref":"#/$defs/config"}},"$defs":{"config":{"type":"object","required":["level"],"properties":{"level":{"type":"integer","minimum":1}}}}}`), &schema)
			c.request("mcpServer/elicitation/request", "extended", map[string]any{"serverName": "tool", "request": map[string]any{"mode": mode, "message": "高级表单", "requestedSchema": schema}})
			s := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
			if !s.Approvals[0].CanAccept || !s.Approvals[0].Elicitation.JSONFallback {
				t.Fatal(s)
			}
			body := map[string]any{"run_id": s.ID, "approval_id": s.Approvals[0].ID, "decision": "accept", "content": map[string]any{"config": map[string]any{"level": 0}}}
			if code, _ := call(t, a, "POST", endpoint+"/approval", body); code != 400 {
				t.Fatal(code)
			}
			body["content"] = map[string]any{"config": map[string]any{"level": 2}}
			if code, raw := call(t, a, "POST", endpoint+"/approval", body); code != 200 {
				t.Fatalf("%d %s", code, raw)
			}
		})
	}
	t.Run("url", func(t *testing.T) {
		a, _, c, endpoint := chatFixture(t)
		startFakeChat(t, a, endpoint)
		opened := ""
		a.openExternal = func(link string) error { opened = link; return nil }
		c.request("mcpServer/elicitation/request", "url", map[string]any{"serverName": "auth", "mode": "url", "message": "请登录", "url": "https://example.com/login?state=123", "elicitationId": "login"})
		s := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
		body := map[string]any{"run_id": s.ID, "approval_id": s.Approvals[0].ID}
		if code, _ := call(t, a, "POST", endpoint+"/approval/open", map[string]any{"run_id": "old", "approval_id": s.Approvals[0].ID}); code != 409 {
			t.Fatal(code)
		}
		if code, raw := call(t, a, "POST", endpoint+"/approval/open", body); code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		if opened != "https://example.com/login?state=123" || len(a.ChatFor("session").snapshot().Approvals) != 1 {
			t.Fatal("URL opening resolved request", opened)
		}
		c.mu.Lock()
		replies := len(c.replies)
		c.mu.Unlock()
		if replies != 0 {
			t.Fatal("opening auto-approved")
		}
		body["decision"] = "accept"
		body["content"] = map[string]any{"draft": "DO_NOT_SEND"}
		if code, _ := call(t, a, "POST", endpoint+"/approval", body); code != 200 {
			t.Fatal(code)
		}
		if reply := lastApprovalReply(t, c); reply["action"] != "accept" || reply["content"] != nil {
			t.Fatal(reply)
		}
		delete(body, "decision")
		delete(body, "content")
		if code, _ := call(t, a, "POST", endpoint+"/approval/open", body); code != 409 {
			t.Fatal("stale URL opened", code)
		}
	})
}

func TestMCPUnrenderableInteractionsRemainRejectable(t *testing.T) {
	for _, request := range []map[string]any{
		{"mode": "url", "url": "javascript:alert(1)"},
		{"mode": "url", "url": "https://user:password@example.com"},
		{"mode": "future"},
		{"mode": "form", "requestedSchema": map[string]any{"$ref": "http://127.0.0.1:1/private"}},
		{"mode": "form", "requestedSchema": map[string]any{"type": "invalid"}},
	} {
		t.Run(fmt.Sprint(request), func(t *testing.T) {
			a, _, c, endpoint := chatFixture(t)
			startFakeChat(t, a, endpoint)
			request["serverName"] = "tool"
			request["message"] = "需要输入"
			c.request("mcpServer/elicitation/request", 1, request)
			s := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
			if s.Approvals[0].CanAccept || s.Approvals[0].Elicitation.Error == "" {
				t.Fatal(s)
			}
			body := map[string]any{"run_id": s.ID, "approval_id": s.Approvals[0].ID, "decision": "accept"}
			if code, _ := call(t, a, "POST", endpoint+"/approval", body); code != 400 {
				t.Fatal(code)
			}
			body["decision"] = "decline"
			if code, _ := call(t, a, "POST", endpoint+"/approval", body); code != 200 {
				t.Fatal(code)
			}
		})
	}
}

func TestCommandApprovalPreservesAdvertisedDecisions(t *testing.T) {
	a, _, c, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	decisions := []any{"acceptForSession", map[string]any{"acceptWithExecpolicyAmendment": map[string]any{"execpolicy_amendment": []string{"go", "test"}}}, map[string]any{"applyNetworkPolicyAmendment": map[string]any{"network_policy_amendment": map[string]string{"host": "example.com", "action": "deny"}}}, "cancel"}
	for index, decision := range decisions {
		c.request("item/commandExecution/requestApproval", index, map[string]any{"command": "go test ./...", "availableDecisions": decisions})
		s := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
		if len(s.Approvals[0].Choices) != 4 {
			t.Fatal(s)
		}
		body := map[string]any{"run_id": s.ID, "approval_id": s.Approvals[0].ID, "decision": "accept"}
		if code, _ := call(t, a, "POST", endpoint+"/approval", body); code != 400 {
			t.Fatal("unoffered accept allowed", code)
		}
		body["decision"] = s.Approvals[0].Choices[index].ID
		if code, raw := call(t, a, "POST", endpoint+"/approval", body); code != 200 {
			t.Fatalf("%d %s", code, raw)
		}
		raw, _ := json.Marshal(decision)
		var expected any
		_ = json.Unmarshal(raw, &expected)
		if !reflect.DeepEqual(lastApprovalReply(t, c)["decision"], expected) {
			t.Fatal(lastApprovalReply(t, c), decision)
		}
	}
}

func TestMCPResolvedRequestsAndEndedTurnsRejectLateAnswers(t *testing.T) {
	a, _, c, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	request := map[string]any{"serverName": "tool", "mode": "form", "message": "确认", "requestedSchema": map[string]any{"type": "object", "properties": map[string]any{}}}
	c.request("mcpServer/elicitation/request", 10, request)
	s := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
	body := map[string]any{"run_id": s.ID, "approval_id": s.Approvals[0].ID, "decision": "accept"}
	c.event("serverRequest/resolved", map[string]any{"requestId": 10})
	awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 0 })
	if code, _ := call(t, a, "POST", endpoint+"/approval", body); code != 409 {
		t.Fatal(code)
	}
	c.request("mcpServer/elicitation/request", 11, request)
	s = awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
	body["approval_id"] = s.Approvals[0].ID
	c.event("turn/completed", map[string]any{"turn": map[string]string{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
	if code, _ := call(t, a, "POST", endpoint+"/approval", body); code != 409 {
		t.Fatal(code)
	}
}
