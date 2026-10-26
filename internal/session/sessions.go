package session

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

// RequirementSession remains an alias for compatibility with task-page clients.
type RequirementSession = model.Session

// Runtime activity is deliberately not persisted with session associations.
func (a *Service) decorateSessionActivity(s *RequirementSession) {
	if run := a.ChatFor(s.ID); run != nil {
		run.mu.Lock()
		if run.state.Busy {
			s.ChatStatus = run.state.Status
		} else if run.state.TurnID != "" {
			s.CompletedRun = run.state.ID
		}
		run.mu.Unlock()
	}
	if s.ChatStatus == "" {
		if bridge := a.BridgeFor(s.ID); bridge != nil {
			bridge.mu.Lock()
			if bridge.active {
				s.ChatStatus = "running"
				if bridge.waiting {
					s.ChatStatus = "waiting"
				}
			}
			bridge.mu.Unlock()
		}
	}
}

func sessionName(s codex.Session) string {
	name := strings.TrimSpace(s.Name)
	// Store only a compact title, never the full conversation preview.
	return string([]rune(name)[:min(160, len([]rune(name)))])
}

func sessionList(c codex.SessionClient, params map[string]any) (codex.SessionPage, error) {
	params["sourceKinds"] = []string{"cli", "vscode", "appServer"}
	params["sortKey"] = "updated_at"
	params["limit"] = 50
	var page codex.SessionPage
	err := c.Call("thread/list", params, &page)
	if page.Data == nil {
		page.Data = []codex.Session{}
	}
	return page, err
}

func readSession(c codex.SessionClient, id string) (codex.Session, error) {
	var response struct {
		Thread codex.Session `json:"thread"`
	}
	err := c.Call("thread/read", map[string]any{"threadId": id, "includeTurns": false}, &response)
	if err == nil && (response.Thread.ID != id || response.Thread.Cwd == "") {
		err = fmt.Errorf("会话元数据不完整，无法继续")
	}
	return response.Thread, err
}

// SaveSession indexes the thread independently. Only explicit manual links are pins.
func (a *Service) SaveSession(requirement string, s codex.Session, source string, observedAt ...int64) error {
	if err := a.Workspace.Store.SaveSession(model.Session{ID: s.ID, Name: sessionName(s), Cwd: s.Cwd, CreatedAt: s.CreatedAt, UpdatedAt: s.UpdatedAt, Source: source}, observedAt...); err != nil {
		return err
	}
	if requirement != "" && source == "manual" {
		_, err := a.Workspace.Store.DB.Exec(`INSERT OR IGNORE INTO task_session_pins(requirement_id,session_id) VALUES(?,?)`, requirement, s.ID)
		return err
	}
	return nil
}

func (a *Service) StoredSessions(requirement string) ([]RequirementSession, error) {
	scope, err := a.taskScope(requirement)
	if err != nil {
		return nil, err
	}
	return a.cachedScope(scope)
}

func requirementSessionPaths(q model.Requirement) []string {
	paths := []string{}
	if q.HasWorkspace {
		paths = append(paths, q.Path)
	}
	for _, m := range q.Members {
		paths = append(paths, m.Path)
	}
	return paths
}

func sessionInRequirement(q model.Requirement, s codex.Session) bool {
	for _, p := range requirementSessionPaths(q) {
		if platform.SameWorkspacePath(s.Cwd, p) {
			return true
		}
	}
	return false
}

func (a *Service) SessionRequirement(w http.ResponseWriter, r *http.Request) (model.Requirement, bool) {
	q, err := a.Workspace.Store.Requirement(r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "任务不存在")
		return q, false
	}
	if err != nil {
		httpx.DbError(w, err)
		return q, false
	}
	return q, true
}

func (a *Service) CodexSessionsHandler(w http.ResponseWriter, r *http.Request) {
	c, err := a.openSessions(r.Context())
	if err != nil {
		httpx.WriteError(w, 503, err.Error())
		return
	}
	defer c.Close()
	params := map[string]any{}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		params["cursor"] = cursor
	}
	if search := strings.TrimSpace(r.URL.Query().Get("search")); search != "" {
		params["searchTerm"] = search
	}
	page, err := sessionList(c, params)
	if err != nil {
		httpx.WriteError(w, 503, err.Error())
		return
	}
	// The picker needs titles and paths; do not send full previews to the browser.
	for i := range page.Data {
		page.Data[i].Name = sessionName(page.Data[i])
		page.Data[i].Preview = ""
		page.Data[i].Path = ""
	}
	httpx.WriteJSON(w, 200, page)
}

func (a *Service) RequirementSessionsHandler(w http.ResponseWriter, r *http.Request) {
	a.SessionsHandler(w, r)
}

func (a *Service) SessionsHandler(w http.ResponseWriter, r *http.Request) {
	scope, err := a.queryScope(r)
	if err != nil {
		status := 400
		if errors.Is(err, sql.ErrNoRows) {
			status = 404
		}
		httpx.WriteError(w, status, err.Error())
		return
	}
	scanStarted := time.Now().UnixMilli()
	titleObservedAt := time.Now().UnixNano()
	archived := r.URL.Query().Get("archived") == "true"
	cached, err := a.cachedScope(scope)
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	failure := func(cause error) {
		filtered := cached[:0]
		for _, s := range cached {
			if s.Archived == archived {
				a.decorateSessionActivity(&s)
				filtered = append(filtered, s)
			}
		}
		cached = filtered
		httpx.WriteJSON(w, 200, map[string]any{"sessions": cached, "error": cause.Error()})
	}
	c, err := a.openSessions(r.Context())
	if err != nil {
		failure(err)
		return
	}
	defer c.Close()
	found := map[string]codex.Session{}
	params := map[string]any{"archived": archived}
	if scope.paths != nil && !scope.linkedOnly {
		params["cwd"] = scope.paths
	}
	seen := map[string]bool{}
	for !scope.linkedOnly {
		page, err := sessionList(c, params)
		if err != nil {
			failure(err)
			return
		}
		for _, s := range page.Data {
			if s.ID != "" && scope.includes(s.ID, s.Cwd) && (!scope.linkedOnly || r.URL.Query().Get("cwd") == "" || platform.SameWorkspacePath(s.Cwd, r.URL.Query().Get("cwd"))) {
				found[s.ID] = s
				if err := a.SaveSession("", s, "workspace", titleObservedAt); err != nil {
					httpx.DbError(w, err)
					return
				}

				if err := a.Workspace.Store.ObserveSessionArchive(s.ID, archived, scanStarted); err != nil {
					httpx.DbError(w, err)
					return
				}
			}
		}
		if page.NextCursor == nil {
			break
		}
		if seen[*page.NextCursor] {
			failure(fmt.Errorf("Codex 会话分页未前进，请重试"))
			return
		}
		seen[*page.NextCursor] = true
		params["cursor"] = *page.NextCursor
	}
	// Cached/missing records and external manual pins are revalidated by ID.
	for _, s := range cached {
		if s.Archived != archived {
			continue
		}
		if _, ok := found[s.ID]; ok {
			continue
		}
		current, readErr := readSession(c, s.ID)
		if readErr == nil {
			found[s.ID] = current
			if err := a.SaveSession("", current, s.Source, titleObservedAt); err != nil {
				httpx.DbError(w, err)
				return
			}
		}
	}
	sessions, err := a.cachedScope(scope)
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	filtered := sessions[:0]
	for _, s := range sessions {
		if s.Archived == archived && (!scope.linkedOnly || r.URL.Query().Get("cwd") == "" || platform.SameWorkspacePath(s.Cwd, r.URL.Query().Get("cwd"))) {
			filtered = append(filtered, s)
		}
	}
	sessions = filtered
	for i := range sessions {
		_, sessions[i].Available = found[sessions[i].ID]
		if !sessions[i].Available {
			sessions[i].Error = "会话暂不可读取，请刷新重试"
		}
		if native, exists := found[sessions[i].ID]; exists {
			activity := a.sessionActivity(r.Context(), native)
			if activity.Status == "running" || activity.Status == "waiting" {
				sessions[i].ChatStatus = activity.Status
			}
		}
		a.decorateSessionActivity(&sessions[i])
	}
	httpx.WriteJSON(w, 200, map[string]any{"sessions": sessions})
}

func (a *Service) UnlinkSessionHandler(w http.ResponseWriter, r *http.Request) {
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	if _, ok := a.SessionRequirement(w, r); !ok {
		return
	}
	if _, err := a.Workspace.Store.DB.Exec(`DELETE FROM task_session_pins WHERE requirement_id=? AND session_id=?`, r.PathValue("id"), r.PathValue("session")); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": "已取消关联，会话仍可从会话页访问"})
}

func (a *Service) LinkSessionHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		SessionID string `json:"session_id"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	input.SessionID = strings.TrimSpace(input.SessionID)
	if input.SessionID == "" || len(input.SessionID) > 200 {
		httpx.WriteError(w, 400, "请输入有效的会话 ID")
		return
	}
	a.Workspace.Mu.Lock()
	_, ok := a.SessionRequirement(w, r)
	a.Workspace.Mu.Unlock()
	if !ok {
		return
	}
	c, err := a.openSessions(r.Context())
	if err != nil {
		httpx.WriteError(w, 503, err.Error())
		return
	}
	defer c.Close()
	titleObservedAt := time.Now().UnixNano()
	s, err := readSession(c, input.SessionID)
	if err != nil {
		httpx.WriteError(w, 422, "无法关联该会话："+err.Error())
		return
	}
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	if err := a.SaveSession(r.PathValue("id"), s, "manual", titleObservedAt); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": "会话已关联到当前任务"})
}

func (a *Service) ResumeSessionHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	if a.ChatBusy(r.PathValue("session")) {
		httpx.WriteError(w, 409, "此会话正在页面运行，请先停止或等待完成，再打开终端继续")
		return
	}
	record, ok := a.requestSession(w, r)
	if !ok {
		return
	}
	id := record.ID
	p := savedSessionPlan(record)
	// Only the deprecated task resume URL supplies an adapter-specific launch plan.
	if legacy, ok := r.Context().Value(legacyResumePlanKey{}).(model.LaunchPlan); ok {
		p = legacy
	}
	c, err := a.openSessions(r.Context())
	if err != nil {
		httpx.WriteError(w, 503, err.Error())
		return
	}
	s, err := readSession(c, id)
	c.Close()
	if err != nil {
		httpx.WriteError(w, 409, "会话暂不可继续："+err.Error())
		return
	}
	if !platform.AbsoluteWorkspacePath(s.Cwd) {
		httpx.WriteError(w, 409, "会话工作目录不是绝对路径")
		return
	}
	if info, err := workspace.Stat(r.Context(), s.Cwd, true); err != nil || !info.IsDir() {
		httpx.WriteError(w, 409, "会话原工作目录不可用，请恢复目录后重试")
		return
	}
	dirs := append([]string{}, p.AdditionalDirectories...)
	if _, legacy := r.Context().Value(legacyResumePlanKey{}).(model.LaunchPlan); legacy {
		dirs = append([]string{p.Cwd}, dirs...)
	}
	if err := a.SaveSession("", s, "codex"); err != nil {
		httpx.DbError(w, err)
		return
	}
	p.Cwd = s.Cwd
	p.Session = id
	if err := a.LaunchConflict(id, p.Cwd); err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	p.AdditionalDirectories = []string{}
	p.Args = []string{"resume", id, "--cd", p.Cwd}
	for _, dir := range dirs {
		if !platform.SameWorkspacePath(dir, p.Cwd) {
			p.AdditionalDirectories = append(p.AdditionalDirectories, dir)
			p.Args = append(p.Args, "--add-dir", dir)
		}
	}
	p.Command = platform.DisplayCommand("codex", p.Args, a.Workspace.ReadOnlySessions && a.Workspace.Remote == nil && platform.NativeWindows())
	p.Title = "Codex · " + sessionName(s)
	a.LaunchCodexPlan(w, p)
}
