package session

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
)

func (a *Service) NewSessionHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	var input struct {
		Text      string `json:"text"`
		Project   string `json:"project_id"`
		RequestID string `json:"request_id"`
		Purpose   string `json:"purpose"`
		MergeHead string `json:"merge_head"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	input.Text = strings.TrimSpace(input.Text)
	if (input.Text == "" && input.Purpose != "merge_conflict") || len(input.Text) > 64000 || input.RequestID == "" || len(input.RequestID) > 100 || (input.Purpose != "" && input.Purpose != "merge_conflict") {
		httpx.WriteError(w, 400, "请输入第一条消息（最多 64000 字节）并提供创建标识")
		return
	}
	// Persist the idempotency key before making any remote mutation. An uncertain
	// creation is never retried implicitly, including after a service restart.
	a.createChatMu.Lock()
	defer a.createChatMu.Unlock()
	id := r.PathValue("id")
	var existing string
	err := a.Workspace.Store.DB.QueryRow(`SELECT session_id FROM session_create_requests WHERE requirement_id=? AND request_id=?`, id, input.RequestID).Scan(&existing)
	if err == nil {
		if existing == "" {
			httpx.WriteError(w, 409, "上次创建结果未确认，为避免重复创建请先刷新关联会话列表检查")
			return
		}
		a.WriteCreatedSession(w, id, existing, 200)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		httpx.DbError(w, err)
		return
	}
	a.Workspace.Mu.Lock()
	var plan model.LaunchPlan
	if input.Purpose == "merge_conflict" {
		plan, input.Text, err = a.mergeConflictPlan(r.Context(), id, input.Project, input.MergeHead)
	} else {
		plan, err = a.plans.MakeLaunchPlan(r.Context(), id)
	}
	q, qerr := a.Workspace.Store.Requirement(id)
	a.Workspace.Mu.Unlock()
	if err != nil || qerr != nil {
		httpx.WriteError(w, 409, "任务尚未就绪或工作目录不可用")
		return
	}
	if input.Purpose == "" && input.Project != "" && input.Project != q.PrimaryProjectID {
		found := false
		for _, m := range q.Members {
			if m.ProjectID == input.Project {
				old := plan.Cwd
				plan.Cwd = m.Path
				for i, p := range plan.AdditionalDirectories {
					if p == m.Path {
						plan.AdditionalDirectories[i] = old
					}
				}
				found = true
				break
			}
		}
		if !found {
			httpx.WriteError(w, 400, "所选项目未关联当前任务")
			return
		}
	}
	if a.BusyWorkspace("", plan.Cwd) {
		httpx.WriteError(w, 409, "此工作目录已有对话正在运行，请等待完成或停止后再发送")
		return
	}
	if err := a.AppTerminalConflict("", plan.Cwd); err != nil {
		httpx.WriteError(w, 409, "所选目录仍有终端工作，为避免同时修改，请先关闭终端 Codex 或切换其关联会话到侧栏")
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	c, err := a.openLive(ctx)
	if err != nil {
		cancel()
		httpx.WriteError(w, 503, err.Error())
		return
	}
	keep := false
	defer func() {
		if !keep {
			c.Close()
			cancel()
		}
	}()
	if _, err := a.Workspace.Store.DB.Exec(`INSERT INTO session_create_requests(requirement_id,request_id) VALUES(?,?)`, id, input.RequestID); err != nil {
		httpx.DbError(w, err)
		return
	}
	requestCtx, end := context.WithTimeout(ctx, 15*time.Second)
	defer end()
	var result struct {
		Thread codex.Session `json:"thread"`
	}
	params := map[string]any{"cwd": plan.Cwd, "sandbox": "workspace-write", "approvalPolicy": "on-request", "developerInstructions": "当前工作属于任务 " + q.Name + "。开始修改前先阅读 " + platform.JoinWorkspacePath(q.Path, "BRIEF.md") + " 和适用的 AGENTS.md；各项目的 Git、构建及测试在对应仓库执行。"}
	if err := c.Call(requestCtx, "thread/start", params, &result); err != nil || result.Thread.ID == "" {
		httpx.WriteError(w, 503, "Codex 创建结果未确认，请刷新会话列表检查后再操作")
		return
	}
	s := result.Thread
	s.Cwd = plan.Cwd
	s.Name = sessionName(codex.Session{Preview: input.Text})
	if s.CreatedAt == 0 {
		s.CreatedAt = time.Now().Unix()
	}
	s.UpdatedAt = s.CreatedAt
	a.Workspace.Mu.Lock()
	err = a.SaveSession(id, s, "workbench")
	a.Workspace.Mu.Unlock()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	if _, err := a.Workspace.Store.DB.Exec(`UPDATE session_create_requests SET session_id=? WHERE requirement_id=? AND request_id=?`, s.ID, id, input.RequestID); err != nil {
		httpx.DbError(w, err)
		return
	}
	run := &ChatRun{requirement: id, session: s.ID, cwd: s.Cwd, created: &s, client: c, cancel: cancel, notify: make(chan struct{}, 1), finished: make(chan struct{}), state: ChatState{ID: input.RequestID, Status: "starting", Busy: true, Entries: []HistoryEntry{}, Approvals: []ChatApproval{}}}
	a.chatMu.Lock()
	a.chats[s.ID] = run
	a.chatMu.Unlock()
	// Keep this exact connection through the first turn: a new thread has no
	// resumable rollout until that turn has begun.
	keep = true
	go a.DriveChat(ctx, run, plan, input.Text)
	a.WriteCreatedSession(w, id, s.ID, 202)
}
func (a *Service) WriteCreatedSession(w http.ResponseWriter, requirement, session string, status int) {
	sessions, err := a.StoredSessions(requirement)
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	for _, s := range sessions {
		if s.ID == session {
			s.Available = true
			chat := ChatState{Status: "idle", Entries: []HistoryEntry{}, Approvals: []ChatApproval{}}
			if run := a.ChatFor(session); run != nil {
				chat = run.snapshot()
			}
			httpx.WriteJSON(w, status, map[string]any{"session": s, "chat": chat})
			return
		}
	}
	httpx.WriteError(w, 409, "已创建的会话关联记录不可用，请刷新后检查")
}
