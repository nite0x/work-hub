package session

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/httpx"
)

func (a *Service) NewSessionHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	var input struct {
		Text                  string       `json:"text"`
		Project               string       `json:"project_id"`
		TaskID                string       `json:"task_id"`
		Cwd                   string       `json:"cwd"`
		RequestID             string       `json:"request_id"`
		Purpose               string       `json:"purpose"`
		MergeHead             string       `json:"merge_head"`
		Images                []string     `json:"images"`
		Settings              TurnSettings `json:"settings"`
		AdditionalDirectories *[]string    `json:"additional_directories"`
	}
	if !httpx.DecodeLimit(w, r, &input, chatRequestLimit) {
		return
	}
	if err := validateChatImages(input.Images); err != nil {
		httpx.WriteError(w, 400, err.Error())
		return
	}
	input.Text = strings.TrimSpace(input.Text)
	if err := input.Settings.validate(); err != nil {
		httpx.WriteError(w, 400, err.Error())
		return
	}
	if (input.Text == "" && len(input.Images) == 0 && input.Purpose != "merge_conflict") || len(input.Text) > 64000 || input.RequestID == "" || len(input.RequestID) > 100 || (input.Purpose != "" && input.Purpose != "merge_conflict") {
		httpx.WriteError(w, 400, "请输入第一条消息或添加图片（文字最多 64000 字节）并提供创建标识")
		return
	}
	// Persist the idempotency key before making any remote mutation. An uncertain
	// creation is never retried implicitly, including after a service restart.
	a.createChatMu.Lock()
	defer a.createChatMu.Unlock()
	taskID := input.TaskID
	key := input.RequestID
	if id := r.PathValue("id"); id != "" {
		taskID = id
		key = "task:" + id + ":" + key
	}
	input.TaskID = taskID
	rawInput, _ := json.Marshal(input)
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(rawInput))
	var existing, previousFingerprint string
	err := a.Workspace.Store.DB.QueryRow(`SELECT session_id,fingerprint FROM conversation_create_requests WHERE request_id=?`, key).Scan(&existing, &previousFingerprint)
	if err == nil {
		if previousFingerprint != "" && previousFingerprint != fingerprint {
			httpx.WriteError(w, 409, "创建标识已用于其他消息或工作目录")
			return
		}
		if existing == "" {
			httpx.WriteError(w, 409, "上次创建结果未确认，为避免重复创建请先刷新会话列表检查")
			return
		}
		a.WriteCreatedSession(w, existing, 200)
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		httpx.DbError(w, err)
		return
	}
	var execution executionContext
	if input.Purpose == "merge_conflict" {
		if taskID == "" {
			httpx.WriteError(w, 400, "合并处理需要任务上下文")
			return
		}
		execution.plan, input.Text, err = a.mergeConflictPlan(r.Context(), taskID, input.Project, input.MergeHead)
	} else {
		execution, err = a.resolveCreation(r.Context(), SessionTarget{TaskID: taskID, ProjectID: input.Project, Cwd: input.Cwd, AdditionalDirectories: input.AdditionalDirectories})
	}
	if err != nil {
		status := 409
		if errors.Is(err, sql.ErrNoRows) {
			status = 404
		}
		var invalidTarget invalidSessionTarget
		if errors.As(err, &invalidTarget) {
			status = 400
		}
		httpx.WriteError(w, status, err.Error())
		return
	}
	plan := execution.plan
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
	if _, err := a.Workspace.Store.DB.Exec(`INSERT INTO conversation_create_requests(request_id,fingerprint) VALUES(?,?)`, key, fingerprint); err != nil {
		httpx.DbError(w, err)
		return
	}
	requestCtx, end := context.WithTimeout(ctx, 15*time.Second)
	defer end()
	var result struct {
		ChatContext
		Thread codex.Session `json:"thread"`
	}
	params := map[string]any{"cwd": plan.Cwd, "sandbox": "workspace-write", "approvalPolicy": "on-request", "config": chatQuestionConfig()}
	setThreadPermissions(params, input.Settings.Permission)
	if execution.instructions != "" {
		params["developerInstructions"] = execution.instructions + "\n" + chatQuestionInstructions
	}
	if err := c.Call(requestCtx, "thread/start", params, &result); err != nil || result.Thread.ID == "" {
		httpx.WriteError(w, 503, "Codex 创建结果未确认，请刷新会话列表检查后再操作")
		return
	}
	s := result.Thread
	if s.Model == "" {
		s.Model = result.ChatContext.Model
	}
	if s.Effort == "" {
		s.Effort = result.ChatContext.Effort
	}
	s.Cwd = plan.Cwd
	s.Name = sessionName(s)
	initialTitle, titleNotice := false, ""
	// This runs exactly once, before the new thread is exposed to Work Hub's
	// rename controls. Never retry an uncertain name write on subsequent turns.
	if s.Name == "" {
		if name := initialSessionTitle(input.Text); name != "" {
			if err := c.Call(requestCtx, "thread/name/set", map[string]any{"threadId": s.ID, "name": name}, &struct{}{}); err == nil {
				s.Name, initialTitle = name, true
			} else {
				titleNotice = "对话已创建，初始标题同步未确认，请刷新核对或手动重命名。"
			}
		}
	}
	if s.CreatedAt == 0 {
		s.CreatedAt = time.Now().Unix()
	}
	s.UpdatedAt = s.CreatedAt
	a.Workspace.Mu.Lock()
	err = a.SaveSession("", s, "workbench")
	if err == nil && taskID != "" {
		_, err = a.Workspace.Store.DB.Exec(`INSERT OR IGNORE INTO task_session_pins(requirement_id,session_id) VALUES(?,?)`, taskID, s.ID)
	}
	a.Workspace.Mu.Unlock()
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	if initialTitle {
		if err := a.Workspace.Store.SetSessionTitle(s.ID, s.Name, "initial"); err != nil {
			httpx.DbError(w, err)
			return
		}
	}
	if _, err := a.Workspace.Store.DB.Exec(`UPDATE conversation_create_requests SET session_id=? WHERE request_id=?`, s.ID, key); err != nil {
		httpx.DbError(w, err)
		return
	}
	if err := a.Workspace.Store.SaveSessionDirectories(s.ID, plan.AdditionalDirectories); err != nil {
		httpx.DbError(w, err)
		return
	}
	run := &ChatRun{session: s.ID, cwd: s.Cwd, created: &s, client: c, cancel: cancel, notify: make(chan struct{}, 1), finished: make(chan struct{}), state: ChatState{ID: input.RequestID, Status: "starting", Busy: true, Entries: []HistoryEntry{}, Approvals: []ChatApproval{}, Notice: titleNotice}}
	run.settings = input.Settings
	a.chatMu.Lock()
	a.chats[s.ID] = run
	a.chatMu.Unlock()
	// Keep this exact connection through the first turn: a new thread has no
	// resumable rollout until that turn has begun.
	keep = true
	go a.DriveChat(ctx, run, plan, input.Text, input.Images...)
	a.WriteCreatedSession(w, s.ID, 202)
}
func (a *Service) WriteCreatedSession(w http.ResponseWriter, session string, status int) {
	s, err := a.Workspace.Store.Session(session)
	if err != nil {
		httpx.WriteError(w, 409, "已创建的会话记录不可用，请刷新后检查")
		return
	}
	s.Available = true
	chat := ChatState{Status: "idle", Entries: []HistoryEntry{}, Approvals: []ChatApproval{}}
	if run := a.ChatFor(session); run != nil {
		chat = run.snapshot()
	}
	httpx.WriteJSON(w, status, map[string]any{"session": s, "chat": chat})
}
