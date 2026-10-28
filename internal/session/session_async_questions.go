package session

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"worktree-hub/internal/httpx"
)

// Async questions are agent messages, not outstanding JSON-RPC requests.
// Their answers are ordinary user input delivered with turn/steer or turn/start.
type asyncUserInputQuestion struct {
	Title   string   `json:"title"`
	Options []string `json:"options"`
}

func asyncChatQuestions(questions []asyncUserInputQuestion) []ChatQuestion {
	result := make([]ChatQuestion, 0, len(questions))
	for i, q := range questions {
		question := ChatQuestion{ID: strconv.Itoa(i), Header: fmt.Sprintf("问题 %d", i+1), Question: q.Title, IsOther: true}
		for _, label := range q.Options {
			question.Options = append(question.Options, struct {
				Label       string `json:"label"`
				Description string `json:"description"`
			}{Label: label})
		}
		result = append(result, question)
	}
	return result
}

func (a *Service) decorateAsyncQuestions(session string, entries []HistoryEntry) error {
	for i := range entries {
		e := &entries[i]
		if e.Delivery != "async" || len(e.Questions) == 0 {
			continue
		}
		var status string
		err := a.Workspace.Store.DB.QueryRow(`SELECT status FROM conversation_async_answers WHERE session_id=? AND item_id=? AND turn_id=?`, session, e.ID, e.TurnID).Scan(&status)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		e.QuestionStatus = status
	}
	return nil
}

// A later user message answers/supersedes older async questions, including
// answers typed in native Codex. Turn completion alone does not clear them.
func (a *Service) pendingAsyncQuestion(ctx context.Context, session, item, turn string) (HistoryEntry, error) {
	check := func(entries []HistoryEntry) (HistoryEntry, bool, error) {
		for i := len(entries) - 1; i >= 0; i-- {
			e := entries[i]
			if e.Kind == "user" {
				return HistoryEntry{}, true, fmt.Errorf("此问询已有后续消息，请刷新后继续")
			}
			if e.ID == item && e.TurnID == turn && e.Delivery == "async" && len(e.Questions) > 0 {
				return e, true, nil
			}
		}
		return HistoryEntry{}, false, nil
	}
	if run := a.ChatFor(session); run != nil {
		snapshot := run.snapshot()
		if snapshot.Busy {
			if entry, found, err := check(snapshot.Entries); found {
				return entry, err
			}
		}
	}
	c, err := a.openSessions(ctx)
	if err != nil {
		return HistoryEntry{}, err
	}
	defer c.Close()
	s, err := readSession(c, session)
	if err != nil {
		return HistoryEntry{}, err
	}
	cursor, seen := "", map[string]bool{}
	for {
		page, err := readSessionHistory(c, s, cursor)
		if err != nil {
			return HistoryEntry{}, err
		}
		if entry, found, err := check(page.Entries); found {
			return entry, err
		}
		if page.NextCursor == nil || *page.NextCursor == "" || seen[*page.NextCursor] {
			return HistoryEntry{}, fmt.Errorf("问询不可用，请刷新会话历史")
		}
		cursor, seen[*page.NextCursor] = *page.NextCursor, true
	}
}

func (a *Service) AsyncQuestionHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	var input struct {
		ItemID   string              `json:"item_id"`
		TurnID   string              `json:"turn_id"`
		Decision string              `json:"decision"`
		Answers  map[string][]string `json:"answers"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if input.ItemID == "" || len(input.ItemID) > 200 || input.TurnID == "" || len(input.TurnID) > 200 || (input.Decision != "accept" && input.Decision != "decline") {
		httpx.WriteError(w, 400, "问询或回答无效")
		return
	}
	record, ok := a.requestSession(w, r)
	if !ok {
		return
	}
	raw, _ := json.Marshal(input)
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(raw))
	requestID := fmt.Sprintf("async-%x", sha256.Sum256([]byte(record.ID+"\x00"+input.TurnID+"\x00"+input.ItemID)))
	state := func() ChatState {
		if run := a.ChatFor(record.ID); run != nil {
			return run.snapshot()
		}
		return ChatState{Status: "idle", Entries: []HistoryEntry{}, Approvals: []ChatApproval{}}
	}
	var previous, status string
	err := a.Workspace.Store.DB.QueryRow(`SELECT fingerprint,status FROM conversation_async_answers WHERE session_id=? AND item_id=? AND turn_id=?`, record.ID, input.ItemID, input.TurnID).Scan(&previous, &status)
	if err == nil {
		if previous != fingerprint {
			httpx.WriteError(w, 409, "此问询已提交其他回答，请刷新历史")
		} else if status == "pending" {
			httpx.WriteError(w, 409, "回答的投递结果未确认，请查看历史后再操作，不会重复投递")
		} else {
			httpx.WriteJSON(w, 200, state())
		}
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		httpx.DbError(w, err)
		return
	}
	question, err := a.pendingAsyncQuestion(r.Context(), record.ID, input.ItemID, input.TurnID)
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	if _, err := questionReply(question.Questions, chatApprovalInput{Decision: input.Decision, Answers: input.Answers}); err != nil {
		httpx.WriteError(w, 400, err.Error())
		return
	}
	parts := []string{"回答之前的问询："}
	for _, q := range question.Questions {
		parts = append(parts, q.Question+"\n"+strings.TrimSpace(strings.Join(input.Answers[q.ID], "\n")))
	}
	text := strings.Join(parts, "\n\n")
	if len(text) > 64000 {
		httpx.WriteError(w, 400, "回答内容过长，请缩短后提交")
		return
	}
	current := state()
	if record.Archived || current.Busy && (current.TurnID == "" || current.Status != "running" && current.Status != "waiting") {
		httpx.WriteError(w, 409, "当前暂不能提交回答，请稍后重试")
		return
	}
	if !current.Busy {
		if external, ok := a.externalActivity(r.Context(), record.ID); ok && (external.Status == "running" || external.Status == "waiting" || external.Status == "unknown" && current.ID == "") {
			httpx.WriteError(w, 409, "请在正在运行此对话的 Codex 窗口回答，或等待本轮结束")
			return
		}
		if err := a.AppTerminalConflict(record.ID, record.Cwd); err != nil {
			httpx.WriteError(w, 409, err.Error())
			return
		}
	}
	status = "pending"
	if input.Decision == "decline" {
		status = "skipped"
	}
	if _, err := a.Workspace.Store.DB.Exec(`INSERT INTO conversation_async_answers(session_id,item_id,turn_id,fingerprint,status,request_id) VALUES(?,?,?,?,?,?)`, record.ID, input.ItemID, input.TurnID, fingerprint, status, requestID); err != nil {
		httpx.DbError(w, err)
		return
	}
	if status == "skipped" {
		httpx.WriteJSON(w, 200, current)
		return
	}
	if current.Busy {
		run := a.ChatFor(record.ID)
		run.mu.Lock()
		client := run.client
		run.mu.Unlock()
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		var result struct {
			TurnID string `json:"turnId"`
		}
		if client == nil {
			err = fmt.Errorf("会话仍在连接")
		} else {
			err = client.Call(ctx, "turn/steer", map[string]any{"threadId": record.ID, "expectedTurnId": current.TurnID, "clientUserMessageId": requestID, "input": chatTurnInput(text, nil)}, &result)
		}
		if err != nil || result.TurnID != current.TurnID {
			httpx.WriteError(w, 409, "回答未确认，请检查历史后再操作；已保留你的选择")
			return
		}
		if _, err := a.Workspace.Store.DB.Exec(`UPDATE conversation_async_answers SET status='accepted' WHERE session_id=? AND request_id=?`, record.ID, requestID); err != nil {
			httpx.DbError(w, err)
			return
		}
	} else {
		ctx, cancel := context.WithCancel(context.Background())
		run := &ChatRun{session: record.ID, cwd: record.Cwd, cancel: cancel, notify: make(chan struct{}, 1), finished: make(chan struct{}), asyncRequest: requestID, started: make(chan struct{}), state: ChatState{ID: requestID, Status: "starting", Busy: true, Entries: []HistoryEntry{}, Approvals: []ChatApproval{}}}
		a.chatMu.Lock()
		a.chats[record.ID] = run
		a.chatMu.Unlock()
		go a.DriveChat(ctx, run, savedSessionPlan(record), text)
		select {
		case <-run.started:
		case <-run.finished:
			// Completion may race with the start acknowledgement. The durable
			// receipt, rather than select ordering, determines delivery success.
			var delivered string
			if err := a.Workspace.Store.DB.QueryRow(`SELECT status FROM conversation_async_answers WHERE session_id=? AND request_id=?`, record.ID, requestID).Scan(&delivered); err != nil || delivered != "accepted" {
				httpx.WriteError(w, 409, "回答未确认："+run.snapshot().Error)
				return
			}
		case <-time.After(30 * time.Second):
			httpx.WriteError(w, 409, "回答仍在连接，请稍后刷新状态确认；不会重复投递")
			return
		case <-r.Context().Done():
			return
		}
	}
	httpx.WriteJSON(w, 200, state())
}
