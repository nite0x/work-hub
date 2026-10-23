package session

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
)

func (run *ChatRun) handle(event codex.Event) bool {
	var p struct {
		ThreadID  string           `json:"threadId"`
		TurnID    string           `json:"turnId"`
		ItemID    string           `json:"itemId"`
		Delta     string           `json:"delta"`
		Item      codexHistoryItem `json:"item"`
		RequestID json.RawMessage  `json:"requestId"`
		Turn      struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"turn"`
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(event.Params, &p); err != nil {
		return false
	}
	if p.ThreadID != run.session {
		return false
	}
	state := run.snapshot()
	if p.TurnID != "" && p.TurnID != state.TurnID {
		return false
	}
	if len(event.ID) > 0 {
		approval, err := makeChatApproval(event)
		if err != nil {
			// Never auto-approve an interaction we cannot render. Reject it and
			// interrupt only the turn started by this page.
			run.mu.Lock()
			c := run.client
			run.mu.Unlock()
			_ = c.Reply(event.ID, map[string]any{"decision": "cancel"})
			_ = run.interrupt()
			run.change(func(s *ChatState) { s.Status = "failed"; s.Error = err.Error() })
			return true
		}
		if event.Method == "item/fileChange/requestApproval" {
			for _, entry := range state.Entries {
				if entry.Kind == "change" && entry.ID == p.ItemID {
					approval.Details += "\n" + entry.Text
				}
			}
		}
		if event.Method == "item/commandExecution/requestApproval" {
			for _, entry := range state.Entries {
				if entry.Kind == "command" && entry.ID == p.ItemID {
					approval.Details = entry.Command + "\n" + entry.Cwd + "\n" + approval.Details
					break
				}
			}
		}
		run.change(func(s *ChatState) { s.Approvals = append(s.Approvals, approval); s.Status = "waiting" })
		return false
	}
	switch event.Method {
	case "item/started", "item/completed":
		if p.Item.Type == "fileChange" {
			text := ""
			for _, change := range p.Item.Changes {
				text += change.Path + "\n" + change.Diff + "\n"
			}
			run.change(func(s *ChatState) {
				upsertLiveEntry(s, HistoryEntry{ID: p.Item.ID, TurnID: p.TurnID, Kind: "change", Text: text, Status: p.Item.Status})
			})
		}
		if e, ok := visibleHistoryEntry(codexHistoryEntry{TurnID: p.TurnID, Item: p.Item}); ok {
			if e.Kind == "assistant" {
				if event.Method == "item/started" {
					e.Status = "inProgress"
				} else {
					e.Status = "completed"
				}
			}
			run.change(func(s *ChatState) { upsertLiveEntry(s, e) })
		}
	case "item/agentMessage/delta":
		run.change(func(s *ChatState) {
			entry := liveEntry(s, p.ItemID, p.TurnID, "assistant")
			entry.Text = boundedChatText(entry.Text + p.Delta)
		})
	case "item/commandExecution/outputDelta":
		run.change(func(s *ChatState) {
			entry := liveEntry(s, p.ItemID, p.TurnID, "command")
			out := ""
			if entry.Output != nil {
				out = *entry.Output
			}
			out = boundedChatText(out + p.Delta)
			entry.Output = &out
		})
	case "item/fileChange/outputDelta": // No terminal text from legacy file-change events.
	case "serverRequest/resolved":
		run.change(func(s *ChatState) {
			pending := []ChatApproval{}
			for _, a := range s.Approvals {
				if string(a.rpcID) != string(p.RequestID) {
					pending = append(pending, a)
				}
			}
			s.Approvals = pending
			if len(pending) == 0 && s.Status == "waiting" {
				s.Status = "running"
			}
		})
	case "turn/completed":
		if p.Turn.ID != state.TurnID {
			return false
		}
		run.change(func(s *ChatState) {
			s.Status = p.Turn.Status
			s.Busy = false
			s.Approvals = []ChatApproval{}
			if p.Turn.Error != nil {
				s.Error = p.Turn.Error.Message
			}
		})
		return true
	case "error":
		if p.Error.Message != "" {
			run.change(func(s *ChatState) { s.Error = p.Error.Message })
		}
	}
	return false
}
func boundedChatText(text string) string {
	const max = 256 * 1024
	if len(text) > max {
		return text[:max] + "\n[实时预览已达 256 KiB，完整内容请在已保存的历史中查看]"
	}
	return text
}
func liveEntry(s *ChatState, id, turn, kind string) *HistoryEntry {
	for i := range s.Entries {
		if s.Entries[i].ID == id && s.Entries[i].TurnID == turn {
			return &s.Entries[i]
		}
	}
	s.Entries = append(s.Entries, HistoryEntry{ID: id, TurnID: turn, Kind: kind, Status: "inProgress"})
	return &s.Entries[len(s.Entries)-1]
}
func upsertLiveEntry(s *ChatState, entry HistoryEntry) {
	if entry.Kind == "command" && entry.Output != nil {
		out := boundedChatText(*entry.Output)
		entry.Output = &out
	}
	entry.Text = boundedChatText(entry.Text)
	old := liveEntry(s, entry.ID, entry.TurnID, entry.Kind)
	// Completion payloads are authoritative; a missing output must not erase
	// output deltas that were already received from this running command.
	if entry.Output == nil && old.Output != nil {
		entry.Output = old.Output
	}
	*old = entry
}
func makeChatApproval(event codex.Event) (ChatApproval, error) {
	var p struct {
		Reason      string            `json:"reason"`
		Command     string            `json:"command"`
		Cwd         string            `json:"cwd"`
		GrantRoot   string            `json:"grantRoot"`
		Permissions json.RawMessage   `json:"permissions"`
		Network     json.RawMessage   `json:"networkApprovalContext"`
		Additional  json.RawMessage   `json:"additionalPermissions"`
		Decisions   []json.RawMessage `json:"availableDecisions"`
		Questions   []ChatQuestion    `json:"questions"`
	}
	if err := json.Unmarshal(event.Params, &p); err != nil {
		return ChatApproval{}, err
	}
	a := ChatApproval{ID: model.NewID(), rpcID: event.ID, method: event.Method, params: event.Params, CanAccept: true}
	switch event.Method {
	case "item/commandExecution/requestApproval":
		a.Kind, a.Title = "decision", "允许执行命令？"
		a.Details = strings.Join([]string{p.Command, p.Cwd, p.Reason}, "\n")
		if len(p.Network) > 0 && string(p.Network) != "null" {
			a.Details += "\n网络请求：" + string(p.Network)
		}
		if len(p.Additional) > 0 && string(p.Additional) != "null" {
			a.Details += "\n附加权限：" + string(p.Additional)
		}
		a.Choices = commandApprovalChoices(p.Decisions)
		a.CanAccept = false
		for _, choice := range a.Choices {
			a.CanAccept = a.CanAccept || choice.Accepts
		}
	case "item/fileChange/requestApproval":
		a.Kind, a.Title = "decision", "允许修改文件？"
		a.Details = p.Reason + "\n" + p.Cwd + "\n" + p.GrantRoot
		a.Choices = commandApprovalChoices([]json.RawMessage{json.RawMessage(`"accept"`), json.RawMessage(`"acceptForSession"`), json.RawMessage(`"decline"`), json.RawMessage(`"cancel"`)})
	case "item/permissions/requestApproval":
		a.Kind, a.Title = "permissions", "允许本轮使用这些权限？"
		a.Details = p.Reason + "\n" + p.Cwd + "\n" + string(p.Permissions)
		a.Choices = []ChatApprovalChoice{{ID: "decline", Label: "拒绝"}, {ID: "accept", Label: "允许本轮", Accepts: true}, {ID: "accept_session", Label: "本会话允许", Accepts: true}}
	case "item/tool/requestUserInput":
		a.Kind, a.Title, a.Questions = "questions", "Codex 需要你的回答", p.Questions
	case "mcpServer/elicitation/request":
		makeElicitation(&a)
	default:
		return a, fmt.Errorf("侧栏暂不支持此交互（%s），已请求停止本轮工作，请在终端继续", event.Method)
	}
	return a, nil
}
func (a *Service) ChatApprovalHandler(w http.ResponseWriter, r *http.Request) {
	var input chatApprovalInput
	if !httpx.Decode(w, r, &input) {
		return
	}
	run := a.ControlledRun(w, r, input.RunID)
	if run == nil {
		return
	}
	run.mu.Lock()
	if !run.state.Busy || run.state.Status == "stopping" {
		run.mu.Unlock()
		httpx.WriteError(w, 409, "此运行已经结束")
		return
	}
	var pending *ChatApproval
	for i := range run.state.Approvals {
		if run.state.Approvals[i].ID == input.ApprovalID {
			copy := run.state.Approvals[i]
			pending = &copy
			break
		}
	}
	if pending == nil {
		run.mu.Unlock()
		httpx.WriteError(w, 409, "此审批已被处理或失效")
		return
	}
	choice, err := approvalChoice(pending, input.Decision)
	if err != nil {
		run.mu.Unlock()
		httpx.WriteError(w, 400, err.Error())
		return
	}
	var result any
	switch pending.Kind {
	case "elicitation":
		result, err = elicitationReply(pending, choice, input.Content)
	case "permissions":
		permissions := json.RawMessage(`{}`)
		if choice.Accepts {
			var p struct {
				Permissions json.RawMessage `json:"permissions"`
			}
			_ = json.Unmarshal(pending.params, &p)
			permissions = p.Permissions
		}
		scope := "turn"
		if input.Decision == "accept_session" {
			scope = "session"
		}
		result = map[string]any{"permissions": permissions, "scope": scope}
	case "questions":
		result, err = questionReply(pending.Questions, input)
	default:
		result = map[string]any{"decision": choice.decision}
	}
	if err != nil {
		run.mu.Unlock()
		httpx.WriteError(w, 400, err.Error())
		return
	}
	// Keep this mutex through the short write so duplicate clicks cannot reply
	// twice to one RPC request, and a completed turn cannot consume an old reply.
	err = run.client.Reply(pending.rpcID, result)
	if err == nil {
		left := []ChatApproval{}
		for _, p := range run.state.Approvals {
			if p.ID != pending.ID {
				left = append(left, p)
			}
		}
		run.state.Approvals = left
		run.state.Revision++
		if len(left) == 0 {
			run.state.Status = "running"
		}
	}
	run.mu.Unlock()
	if err != nil {
		httpx.WriteError(w, 503, "审批未送达："+err.Error())
		return
	}
	select {
	case run.notify <- struct{}{}:
	default:
	}
	httpx.WriteJSON(w, 200, run.snapshot())
}
