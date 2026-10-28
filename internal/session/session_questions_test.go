package session

import (
	"reflect"
	"strings"
	"testing"
)

func TestChatQuestionsEnabledForCreatedAndResumedThreads(t *testing.T) {
	for _, createThread := range []bool{false, true} {
		t.Run(map[bool]string{false: "resume", true: "create"}[createThread], func(t *testing.T) {
			a, q, c, endpoint := chatFixture(t)
			method := "thread/resume"
			if createThread {
				method = "thread/start"
				if code, raw := call(t, a, "POST", "/api/sessions/new", map[string]string{"task_id": q.ID, "request_id": "questions", "text": "选择标题方案"}); code != 202 {
					t.Fatalf("%d %s", code, raw)
				}
				awaitChat(t, a, func(s ChatState) bool { return s.Status == "running" })
			} else {
				startFakeChat(t, a, endpoint)
			}
			c.mu.Lock()
			params := c.threadParams[method]
			c.mu.Unlock()
			if params["config"].(map[string]any)["features.default_mode_request_user_input"] != true {
				t.Fatal("default-mode questions not enabled on thread", params)
			}
			if createThread && !strings.Contains(params["developerInstructions"].(string), "request_user_input") {
				t.Fatal("new threads lack structured question guidance")
			}
			if !createThread {
				for _, key := range []string{"developerInstructions", "baseInstructions", "approvalPolicy", "sandbox", "cwd"} {
					if _, overridden := params[key]; overridden {
						t.Fatal("resume overwrote existing thread context", key)
					}
				}
			}
			c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
			awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
		})
	}
}

func TestStructuredQuestionRoundTripKeepsQuestionIDsAndMetadata(t *testing.T) {
	a, _, c, endpoint := chatFixture(t)
	startFakeChat(t, a, endpoint)
	c.request("item/tool/requestUserInput", "title-question", map[string]any{"questions": []any{
		map[string]any{"id": "title", "header": "标题", "question": "对话标题怎么处理？", "isOther": true, "options": []any{map[string]any{"label": "自动生成", "description": "首轮完成后生成简短主题"}}},
		map[string]any{"id": "scope", "header": "范围", "question": "应用到哪些会话？", "isSecret": true},
	}})
	s := awaitChat(t, a, func(s ChatState) bool { return len(s.Approvals) == 1 })
	approval := s.Approvals[0]
	if approval.Kind != "questions" || len(approval.Questions) != 2 || !approval.Questions[0].IsOther || !approval.Questions[1].IsSecret {
		t.Fatal("question metadata lost", approval)
	}
	answers := map[string][]string{"title": {"自动生成\n\n保留手动改名"}, "scope": {"新建会话"}}
	body := map[string]any{"run_id": s.ID, "approval_id": approval.ID, "decision": "accept", "answers": answers}
	if code, raw := call(t, a, "POST", endpoint+"/approval", body); code != 200 {
		t.Fatalf("%d %s", code, raw)
	}
	reply := lastApprovalReply(t, c)
	want := map[string]any{"title": map[string]any{"answers": []any{answers["title"][0]}}, "scope": map[string]any{"answers": []any{"新建会话"}}}
	if !reflect.DeepEqual(reply["answers"], want) {
		t.Fatal("answers did not reach the native request", reply)
	}
	if code, _ := call(t, a, "POST", endpoint+"/approval", body); code != 409 {
		t.Fatal("answered the same request twice", code)
	}
	c.mu.Lock()
	if len(c.replies) != 1 || !strings.HasPrefix(c.replies[0], `"title-question":`) {
		t.Fatal("reply targeted a different request", c.replies)
	}
	c.mu.Unlock()
	c.event("turn/completed", map[string]any{"turn": map[string]any{"id": "turn", "status": "completed"}})
	awaitChat(t, a, func(s ChatState) bool { return !s.Busy })
}
