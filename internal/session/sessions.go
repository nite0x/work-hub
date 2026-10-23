package session

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/workspace"
)

type RequirementSession struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Cwd          string `json:"cwd"`
	CreatedAt    int64  `json:"created_at"`
	UpdatedAt    int64  `json:"updated_at"`
	Source       string `json:"source"`
	Available    bool   `json:"available"`
	Error        string `json:"error,omitempty"`
	ChatStatus   string `json:"chat_status,omitempty"`
	CompletedRun string `json:"completed_run,omitempty"`
}

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
	if name == "" {
		name = strings.TrimSpace(s.Preview)
	}
	if name == "" {
		name = "Codex 会话 " + s.ID
	}
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

func (a *Service) SaveSession(requirement string, s codex.Session, source string) error {
	_, err := a.Workspace.Store.DB.Exec(`INSERT INTO requirement_sessions(requirement_id,session_id,name,cwd,created_at,updated_at,source)
 VALUES(?,?,?,?,?,?,?) ON CONFLICT(requirement_id,session_id) DO UPDATE SET
 name=excluded.name,cwd=excluded.cwd,created_at=excluded.created_at,updated_at=excluded.updated_at`,
		requirement, s.ID, sessionName(s), s.Cwd, s.CreatedAt, s.UpdatedAt, source)
	return err
}

func (a *Service) StoredSessions(requirement string) ([]RequirementSession, error) {
	rows, err := a.Workspace.Store.DB.Query(`SELECT session_id,name,cwd,created_at,updated_at,source FROM requirement_sessions WHERE requirement_id=? ORDER BY updated_at DESC,session_id`, requirement)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []RequirementSession{}
	for rows.Next() {
		var s RequirementSession
		if err := rows.Scan(&s.ID, &s.Name, &s.Cwd, &s.CreatedAt, &s.UpdatedAt, &s.Source); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Worktree paths are unique across requirements. Multiple sessions in one of
// these directories all belong to the same requirement, independent of whether
// they were launched by this page or by the user's shell.
func requirementSessionPaths(q model.Requirement) []string {
	paths := []string{q.Path}
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
	}
	httpx.WriteJSON(w, 200, page)
}

func (a *Service) RequirementSessionsHandler(w http.ResponseWriter, r *http.Request) {
	a.Workspace.Mu.Lock()
	q, ok := a.SessionRequirement(w, r)
	a.Workspace.Mu.Unlock()
	if !ok {
		return
	}
	c, err := a.openSessions(r.Context())
	if err != nil {
		a.SessionReadFailure(w, q.ID, err)
		return
	}
	defer c.Close()
	found := map[string]codex.Session{}
	params := map[string]any{"cwd": requirementSessionPaths(q)}
	seenCursors := map[string]bool{}
	for {
		page, err := sessionList(c, params)
		if err != nil {
			a.SessionReadFailure(w, q.ID, err)
			return
		}
		for _, s := range page.Data {
			if s.ID != "" && sessionInRequirement(q, s) {
				found[s.ID] = s
			}
		}
		if page.NextCursor == nil {
			break
		}
		if seenCursors[*page.NextCursor] {
			httpx.WriteError(w, 503, "Codex 会话分页未前进，请重试")
			return
		}
		seenCursors[*page.NextCursor] = true
		params["cursor"] = *page.NextCursor
	}
	for _, s := range found {
		if err := a.SaveSession(q.ID, s, "workspace"); err != nil {
			httpx.DbError(w, err)
			return
		}
	}
	stored, err := a.StoredSessions(q.ID)
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	for i := range stored {
		s := &stored[i]
		current, ok := found[s.ID]
		if !ok {
			current, err = readSession(c, s.ID)
			if err != nil {
				s.Error = "会话暂不可读取：" + err.Error()
				continue
			}
			if err := a.SaveSession(q.ID, current, s.Source); err != nil {
				httpx.DbError(w, err)
				return
			}
		}
		s.Name, s.Cwd, s.CreatedAt, s.UpdatedAt, s.Available = sessionName(current), current.Cwd, current.CreatedAt, current.UpdatedAt, true
	}
	sort.SliceStable(stored, func(i, j int) bool { return stored[i].UpdatedAt > stored[j].UpdatedAt })
	for i := range stored {
		a.decorateSessionActivity(&stored[i])
	}
	httpx.WriteJSON(w, 200, map[string]any{"sessions": stored})
}

// Persisted associations remain visible after a restart even when Codex is
// temporarily unavailable. Cached entries stay disabled until verified again.
func (a *Service) SessionReadFailure(w http.ResponseWriter, requirement string, cause error) {
	stored, err := a.StoredSessions(requirement)
	if err != nil {
		httpx.DbError(w, err)
		return
	}
	for i := range stored {
		a.decorateSessionActivity(&stored[i])
	}
	httpx.WriteJSON(w, 200, map[string]any{"sessions": stored, "error": cause.Error()})
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
	s, err := readSession(c, input.SessionID)
	if err != nil {
		httpx.WriteError(w, 422, "无法关联该会话："+err.Error())
		return
	}
	a.Workspace.Mu.Lock()
	defer a.Workspace.Mu.Unlock()
	if err := a.SaveSession(r.PathValue("id"), s, "manual"); err != nil {
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
	p, err := a.plans.MakeLaunchPlan(r.Context(), r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "任务不存在")
		return
	}
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	var id string
	err = a.Workspace.Store.DB.QueryRow(`SELECT session_id FROM requirement_sessions WHERE requirement_id=? AND session_id=?`, r.PathValue("id"), r.PathValue("session")).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		httpx.WriteError(w, 404, "会话未关联到该任务，请先关联")
		return
	}
	if err != nil {
		httpx.DbError(w, err)
		return
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
	dirs := append([]string{p.Cwd}, p.AdditionalDirectories...)
	p.Cwd = s.Cwd
	p.Session = id
	if a.BusyWorkspace(id, p.Cwd) {
		httpx.WriteError(w, 409, "此会话或工作目录正在侧栏运行，请先等待完成")
		return
	}
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
