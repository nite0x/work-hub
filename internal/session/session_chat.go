package session

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

type ChatApproval struct {
	ID        string         `json:"id"`
	Kind      string         `json:"kind"`
	Title     string         `json:"title"`
	Details   string         `json:"details"`
	Questions []ChatQuestion `json:"questions,omitempty"`
	CanAccept bool           `json:"can_accept"`
	rpcID     json.RawMessage
	method    string
	params    json.RawMessage
}
type ChatQuestion struct {
	ID       string `json:"id"`
	Header   string `json:"header"`
	Question string `json:"question"`
	IsSecret bool   `json:"isSecret"`
	Options  []struct {
		Label       string `json:"label"`
		Description string `json:"description"`
	} `json:"options"`
}
type ChatState struct {
	Revision   uint64         `json:"revision"`
	ID         string         `json:"id,omitempty"`
	Status     string         `json:"status"`
	Busy       bool           `json:"busy"`
	TurnID     string         `json:"turn_id,omitempty"`
	Entries    []HistoryEntry `json:"entries"`
	Approvals  []ChatApproval `json:"approvals"`
	Error      string         `json:"error,omitempty"`
	Blocked    string         `json:"blocked,omitempty"`
	CanHandoff bool           `json:"can_handoff"`
	Notice     string         `json:"notice,omitempty"`
}
type ChatRun struct {
	mu                        sync.Mutex
	state                     ChatState
	requirement, session, cwd string
	client                    codex.LiveClient
	cancel                    context.CancelFunc
	notify                    chan struct{}
	finished                  chan struct{}
	ended                     time.Time
	created                   *codex.Session
	handoff                   bool
}

func (run *ChatRun) snapshot() ChatState {
	run.mu.Lock()
	defer run.mu.Unlock()
	s := run.state
	s.Entries = append([]HistoryEntry{}, s.Entries...)
	s.Approvals = append([]ChatApproval{}, s.Approvals...)
	return s
}
func (run *ChatRun) change(fn func(*ChatState)) {
	run.mu.Lock()
	fn(&run.state)
	run.state.Revision++
	run.mu.Unlock()
	select {
	case run.notify <- struct{}{}:
	default:
	}
}
func (a *Service) ChatFor(session string) *ChatRun {
	a.chatMu.Lock()
	defer a.chatMu.Unlock()
	return a.chats[session]
}
func (a *Service) ChatBusy(session string) bool {
	run := a.ChatFor(session)
	return run != nil && run.snapshot().Busy
}
func (a *Service) BusyWorkspace(session, cwd string) bool {
	a.chatMu.Lock()
	defer a.chatMu.Unlock()
	for _, run := range a.chats {
		run.mu.Lock()
		busy := run.state.Busy && (run.session == session || run.cwd == cwd)
		run.mu.Unlock()
		if busy {
			return true
		}
	}
	return false
}
func (a *Service) CloseChats() {
	a.chatMu.Lock()
	runs := []*ChatRun{}
	for _, run := range a.chats {
		runs = append(runs, run)
	}
	a.chatMu.Unlock()
	for _, run := range runs {
		if run.snapshot().Busy {
			_ = run.interrupt()
		}
		run.cancel()
	}
	for _, run := range runs {
		select {
		case <-run.finished:
		case <-time.After(3 * time.Second):
		}
	}
}
func (a *Service) LinkedChatSession(w http.ResponseWriter, r *http.Request) (model.Requirement, string, bool) {
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	q, ok := a.SessionRequirement(w, r)
	if !ok {
		return q, "", false
	}
	var cwd string
	err := a.Workspace.Store.DB.QueryRow(`SELECT cwd FROM requirement_sessions WHERE requirement_id=? AND session_id=?`, q.ID, r.PathValue("session")).Scan(&cwd)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "会话未关联到该任务")
		return q, "", false
	}
	if err != nil {
		httpx.DbError(w, err)
		return q, "", false
	}
	return q, cwd, true
}
func (a *Service) ChatStateHandler(w http.ResponseWriter, r *http.Request) {
	_, cwd, ok := a.LinkedChatSession(w, r)
	if !ok {
		return
	}
	if run := a.ChatFor(r.PathValue("session")); run != nil {
		s := run.snapshot()
		if run.requirement == r.PathValue("id") {
			if !s.Busy {
				s.Blocked = ""
				if err := a.AppTerminalConflict(r.PathValue("session"), cwd); err != nil {
					s.Blocked = err.Error()
				}
			}
			if !s.Busy {
				a.DecorateHandoff(&s, r.PathValue("session"), cwd)
			}
			httpx.WriteJSON(w, 200, s)
			return
		}
		if s.Busy {
			httpx.WriteJSON(w, 200, ChatState{Status: "conflict", Blocked: "此会话正在另一个任务页面运行"})
			return
		}
	}
	s := ChatState{Status: "idle", Entries: []HistoryEntry{}, Approvals: []ChatApproval{}}
	if err := a.AppTerminalConflict(r.PathValue("session"), cwd); err != nil {
		s.Status, s.Blocked = "conflict", err.Error()
	}
	a.DecorateHandoff(&s, r.PathValue("session"), cwd)
	httpx.WriteJSON(w, 200, s)
}
func (a *Service) ChatStartHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	var input struct {
		Text      string `json:"text"`
		RequestID string `json:"request_id"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	input.Text = strings.TrimSpace(input.Text)
	if input.Text == "" || len(input.Text) > 64000 || len(input.RequestID) > 100 || input.RequestID == "" {
		httpx.WriteError(w, 400, "请输入文字消息（最多 64000 字节）并提供发送标识")
		return
	}
	q, cwd, ok := a.LinkedChatSession(w, r)
	if !ok {
		return
	}
	a.Workspace.Mu.Lock()
	plan, err := a.plans.MakeLaunchPlan(r.Context(), q.ID)
	a.Workspace.Mu.Unlock()
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	if a.BusyWorkspace("", cwd) && !a.ChatBusy(r.PathValue("session")) {
		httpx.WriteError(w, 409, "此工作目录已有其他对话运行，请等待完成或停止后再发送")
		return
	}
	a.chatMu.Lock()
	if previous := a.chats[r.PathValue("session")]; previous != nil {
		s := previous.snapshot()
		if s.ID == input.RequestID && previous.requirement == q.ID {
			a.chatMu.Unlock()
			httpx.WriteJSON(w, 200, s)
			return
		}
		if s.Busy {
			a.chatMu.Unlock()
			httpx.WriteError(w, 409, "该会话正在运行，请等待完成或停止后再发送")
			return
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &ChatRun{requirement: q.ID, session: r.PathValue("session"), cwd: cwd, cancel: cancel, notify: make(chan struct{}, 1), finished: make(chan struct{}), state: ChatState{ID: input.RequestID, Status: "starting", Busy: true, Entries: []HistoryEntry{}, Approvals: []ChatApproval{}}}
	// Keep only recent finished snapshots; active turns are never evicted.
	for id, old := range a.chats {
		old.mu.Lock()
		expired := !old.ended.IsZero() && time.Since(old.ended) > 10*time.Minute
		old.mu.Unlock()
		if expired {
			delete(a.chats, id)
		}
	}
	a.chats[run.session] = run
	a.chatMu.Unlock()
	go a.DriveChat(ctx, run, plan, input.Text)
	httpx.WriteJSON(w, 202, run.snapshot())
}
func (a *Service) DriveChat(ctx context.Context, run *ChatRun, plan model.LaunchPlan, text string) {
	defer close(run.finished)
	defer run.cancel()
	defer func() { run.mu.Lock(); run.ended = time.Now(); run.mu.Unlock() }()
	defer run.change(func(s *ChatState) {
		s.Busy = false
		s.Approvals = []ChatApproval{}
		if s.Status == "starting" || s.Status == "running" || s.Status == "waiting" || s.Status == "stopping" {
			s.Status = "failed"
			if s.Error == "" {
				s.Error = "会话连接已结束，请检查已保存的进展后重试"
			}
		}
	})
	fail := func(message string) {
		run.change(func(s *ChatState) {
			if s.Status == "stopping" {
				s.Status = "interrupted"
				s.Error = ""
			} else {
				s.Status = "failed"
				s.Error = message
			}
		})
	}
	c := run.client
	var err error
	if c == nil {
		c, err = a.openLive(ctx)
	}
	if err != nil {
		fail(err.Error())
		return
	}
	run.mu.Lock()
	run.client = c
	run.mu.Unlock()
	defer c.Close()
	call := func(method string, params any, result any) error {
		requestCtx, end := context.WithTimeout(ctx, 15*time.Second)
		defer end()
		return c.Call(requestCtx, method, params, result)
	}
	var metadata struct {
		Thread struct {
			codex.Session
			Status struct {
				Type string `json:"type"`
			} `json:"status"`
		} `json:"thread"`
	}
	if run.created != nil {
		metadata.Thread.Session = *run.created
	} else if err := call("thread/read", map[string]any{"threadId": run.session, "includeTurns": false}, &metadata); err != nil {
		fail(err.Error())
		return
	}
	s := metadata.Thread.Session
	if s.ID != run.session || !platform.AbsoluteWorkspacePath(s.Cwd) {
		fail("会话工作目录不可用")
		return
	}
	fileCtx := workspace.WithClient(ctx, a.Workspace.Remote)
	if info, err := workspace.Stat(fileCtx, s.Cwd, true); err != nil || !info.IsDir() {
		fail("会话原工作目录不可用")
		return
	}
	run.mu.Lock()
	run.cwd = s.Cwd
	run.mu.Unlock()
	checkOwner := func() error {
		if err := a.AppTerminalConflict(run.session, s.Cwd); err != nil {
			return err
		}
		if metadata.Thread.Status.Type == "active" {
			return fmt.Errorf("此会话正在其他 Codex 客户端运行，请等待完成后重试")
		}
		return nil
	}
	if err := checkOwner(); err != nil {
		run.change(func(s *ChatState) { s.Status = "conflict"; s.Error = err.Error() })
		return
	}
	var resumed struct {
		Thread struct {
			Status struct {
				Type string `json:"type"`
			} `json:"status"`
		} `json:"thread"`
		Sandbox map[string]any `json:"sandbox"`
	}
	if run.created != nil {
		resumed.Sandbox = map[string]any{"type": "workspaceWrite", "writableRoots": []any{s.Cwd}, "networkAccess": false}
	} else if err := call("thread/resume", map[string]any{"threadId": run.session, "excludeTurns": true}, &resumed); err != nil {
		fail(err.Error())
		return
	}
	defer func() {
		endCtx, end := context.WithTimeout(context.Background(), 2*time.Second)
		defer end()
		_ = c.Call(endCtx, "thread/unsubscribe", map[string]any{"threadId": run.session}, nil)
	}()
	metadata.Thread.Status.Type = resumed.Thread.Status.Type
	if err := checkOwner(); err != nil {
		run.change(func(s *ChatState) { s.Status = "conflict"; s.Error = err.Error() })
		return
	}
	params := map[string]any{"threadId": run.session, "cwd": s.Cwd, "input": []any{map[string]any{"type": "text", "text": text}}}
	// Preserve the session's model and approval policy. Only add the requirement's
	// project roots when the session already uses the workspace-write sandbox.
	if resumed.Sandbox["type"] == "workspaceWrite" {
		roots, _ := resumed.Sandbox["writableRoots"].([]any)
		for _, dir := range append([]string{plan.Cwd}, plan.AdditionalDirectories...) {
			roots = append(roots, dir)
		}
		resumed.Sandbox["writableRoots"] = roots
		params["sandboxPolicy"] = resumed.Sandbox
	}
	var started struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
	}
	if err := call("turn/start", params, &started); err != nil {
		fail(err.Error())
		return
	}
	if started.Turn.ID == "" {
		fail("Codex 未返回运行标识，请刷新历史检查进展")
		return
	}
	run.change(func(state *ChatState) { state.TurnID = started.Turn.ID; state.Status = "running" })
	watch := time.NewTicker(time.Second)
	defer watch.Stop()
	budget := time.NewTimer(30 * time.Minute)
	defer budget.Stop()
	for {
		select {
		case event, ok := <-c.Events():
			if !ok {
				fail("Codex 实时连接断开，请刷新历史检查已保存的进展")
				return
			}
			if run.handle(event) {
				return
			}
		case <-watch.C:
			if err := a.AppTerminalConflict(run.session, s.Cwd); err != nil {
				_ = run.interrupt()
				run.change(func(s *ChatState) {
					s.Status = "conflict"
					s.Error = "会话占用检查未通过，已请求停止页面发起的工作：" + err.Error()
				})
				return
			}
		case <-ctx.Done():
			_ = run.interrupt()
			fail("页面会话已停止或达到 30 分钟运行上限，请刷新历史检查进展")
			return
		case <-budget.C:
			_ = run.interrupt()
			fail("已达到 30 分钟运行上限并请求停止，请检查已保存的进展后继续")
			return
		}
	}
}
func (run *ChatRun) interrupt() error {
	run.mu.Lock()
	client, id := run.client, run.state.TurnID
	if run.handoff {
		run.mu.Unlock()
		run.cancel()
		return nil
	}
	run.mu.Unlock()
	if client == nil || id == "" {
		run.cancel()
		return nil
	}
	ctx, end := context.WithTimeout(context.Background(), 5*time.Second)
	defer end()
	return client.Call(ctx, "turn/interrupt", map[string]any{"threadId": run.session, "turnId": id}, nil)
}
func (a *Service) ControlledRun(w http.ResponseWriter, r *http.Request, id string) *ChatRun {
	if _, _, ok := a.LinkedChatSession(w, r); !ok {
		return nil
	}
	run := a.ChatFor(r.PathValue("session"))
	if run == nil || run.requirement != r.PathValue("id") || run.snapshot().ID != id {
		httpx.WriteError(w, 409, "页面运行已变化，请重新打开会话后重试")
		return nil
	}
	return run
}
func (a *Service) ChatStopHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		RunID string `json:"run_id"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	run := a.ControlledRun(w, r, input.RunID)
	if run == nil {
		return
	}
	if !run.snapshot().Busy {
		httpx.WriteJSON(w, 200, run.snapshot())
		return
	}
	run.change(func(s *ChatState) { s.Status = "stopping" })
	if err := run.interrupt(); err != nil {
		run.change(func(s *ChatState) {
			if s.Busy {
				s.Status = "running"
				if len(s.Approvals) > 0 {
					s.Status = "waiting"
				}
			}
		})
		httpx.WriteError(w, 503, "停止请求未确认："+err.Error())
		return
	}
	run.change(func(s *ChatState) {
		if s.Busy {
			s.Status = "stopping"
		}
	})
	httpx.WriteJSON(w, 200, run.snapshot())
}
func (a *Service) ChatEventsHandler(w http.ResponseWriter, r *http.Request) {
	run := a.ControlledRun(w, r, r.URL.Query().Get("run"))
	if run == nil {
		return
	}
	flusher, ok := w.(http.Flusher)
	if !ok {
		httpx.WriteError(w, 500, "浏览器连接不支持实时输出")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("X-Accel-Buffering", "no")
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	last := ^uint64(0)
	for {
		s := run.snapshot()
		if s.Revision != last {
			raw, _ := json.Marshal(s)
			_, err := fmt.Fprintf(w, "data: %s\n\n", raw)
			if err != nil {
				return
			}
			flusher.Flush()
			last = s.Revision
		}
		if !s.Busy {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-tick.C:
		}
	}
}
