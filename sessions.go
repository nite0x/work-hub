package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
)

type RequirementSession struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Cwd       string `json:"cwd"`
	CreatedAt int64  `json:"created_at"`
	UpdatedAt int64  `json:"updated_at"`
	Source    string `json:"source"`
	Available bool   `json:"available"`
	Error     string `json:"error,omitempty"`
}

func sessionName(s CodexSession) string {
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

func sessionList(c sessionClient, params map[string]any) (CodexSessionPage, error) {
	params["sourceKinds"] = []string{"cli", "vscode", "appServer"}
	params["sortKey"] = "updated_at"
	params["limit"] = 50
	var page CodexSessionPage
	err := c.call("thread/list", params, &page)
	if page.Data == nil {
		page.Data = []CodexSession{}
	}
	return page, err
}

func readSession(c sessionClient, id string) (CodexSession, error) {
	var response struct {
		Thread CodexSession `json:"thread"`
	}
	err := c.call("thread/read", map[string]any{"threadId": id, "includeTurns": false}, &response)
	if err == nil && (response.Thread.ID != id || response.Thread.Cwd == "") {
		err = fmt.Errorf("会话元数据不完整，无法继续")
	}
	return response.Thread, err
}

func (a *App) saveSession(requirement string, s CodexSession, source string) error {
	_, err := a.db.Exec(`INSERT INTO requirement_sessions(requirement_id,session_id,name,cwd,created_at,updated_at,source)
 VALUES(?,?,?,?,?,?,?) ON CONFLICT(requirement_id,session_id) DO UPDATE SET
 name=excluded.name,cwd=excluded.cwd,created_at=excluded.created_at,updated_at=excluded.updated_at`,
		requirement, s.ID, sessionName(s), s.Cwd, s.CreatedAt, s.UpdatedAt, source)
	return err
}

func (a *App) storedSessions(requirement string) ([]RequirementSession, error) {
	rows, err := a.db.Query(`SELECT session_id,name,cwd,created_at,updated_at,source FROM requirement_sessions WHERE requirement_id=? ORDER BY updated_at DESC,session_id`, requirement)
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
func requirementSessionPaths(q Requirement) []string {
	paths := []string{q.Path}
	for _, m := range q.Members {
		paths = append(paths, m.Path)
	}
	return paths
}

func sessionInRequirement(q Requirement, s CodexSession) bool {
	for _, p := range requirementSessionPaths(q) {
		if sameWorkspacePath(s.Cwd, p) {
			return true
		}
	}
	return false
}

func (a *App) sessionRequirement(w http.ResponseWriter, r *http.Request) (Requirement, bool) {
	q, err := a.requirement(r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, 404, "任务不存在")
		return q, false
	}
	if err != nil {
		dbError(w, err)
		return q, false
	}
	return q, true
}

func (a *App) codexSessionsHandler(w http.ResponseWriter, r *http.Request) {
	c, err := a.openSessions(r.Context())
	if err != nil {
		writeError(w, 503, err.Error())
		return
	}
	defer c.close()
	params := map[string]any{}
	if cursor := r.URL.Query().Get("cursor"); cursor != "" {
		params["cursor"] = cursor
	}
	if search := strings.TrimSpace(r.URL.Query().Get("search")); search != "" {
		params["searchTerm"] = search
	}
	page, err := sessionList(c, params)
	if err != nil {
		writeError(w, 503, err.Error())
		return
	}
	// The picker needs titles and paths; do not send full previews to the browser.
	for i := range page.Data {
		page.Data[i].Name = sessionName(page.Data[i])
		page.Data[i].Preview = ""
	}
	writeJSON(w, 200, page)
}

func (a *App) requirementSessionsHandler(w http.ResponseWriter, r *http.Request) {
	a.mu.Lock()
	q, ok := a.sessionRequirement(w, r)
	a.mu.Unlock()
	if !ok {
		return
	}
	c, err := a.openSessions(r.Context())
	if err != nil {
		a.sessionReadFailure(w, q.ID, err)
		return
	}
	defer c.close()
	found := map[string]CodexSession{}
	params := map[string]any{"cwd": requirementSessionPaths(q)}
	seenCursors := map[string]bool{}
	for {
		page, err := sessionList(c, params)
		if err != nil {
			a.sessionReadFailure(w, q.ID, err)
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
			writeError(w, 503, "Codex 会话分页未前进，请重试")
			return
		}
		seenCursors[*page.NextCursor] = true
		params["cursor"] = *page.NextCursor
	}
	for _, s := range found {
		if err := a.saveSession(q.ID, s, "workspace"); err != nil {
			dbError(w, err)
			return
		}
	}
	stored, err := a.storedSessions(q.ID)
	if err != nil {
		dbError(w, err)
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
			if err := a.saveSession(q.ID, current, s.Source); err != nil {
				dbError(w, err)
				return
			}
		}
		s.Name, s.Cwd, s.CreatedAt, s.UpdatedAt, s.Available = sessionName(current), current.Cwd, current.CreatedAt, current.UpdatedAt, true
	}
	sort.SliceStable(stored, func(i, j int) bool { return stored[i].UpdatedAt > stored[j].UpdatedAt })
	writeJSON(w, 200, map[string]any{"sessions": stored})
}

// Persisted associations remain visible after a restart even when Codex is
// temporarily unavailable. Cached entries stay disabled until verified again.
func (a *App) sessionReadFailure(w http.ResponseWriter, requirement string, cause error) {
	stored, err := a.storedSessions(requirement)
	if err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"sessions": stored, "error": cause.Error()})
}

func (a *App) linkSessionHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		SessionID string `json:"session_id"`
	}
	if !decode(w, r, &input) {
		return
	}
	input.SessionID = strings.TrimSpace(input.SessionID)
	if input.SessionID == "" || len(input.SessionID) > 200 {
		writeError(w, 400, "请输入有效的会话 ID")
		return
	}
	a.mu.Lock()
	_, ok := a.sessionRequirement(w, r)
	a.mu.Unlock()
	if !ok {
		return
	}
	c, err := a.openSessions(r.Context())
	if err != nil {
		writeError(w, 503, err.Error())
		return
	}
	defer c.close()
	s, err := readSession(c, input.SessionID)
	if err != nil {
		writeError(w, 422, "无法关联该会话："+err.Error())
		return
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if err := a.saveSession(r.PathValue("id"), s, "manual"); err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, 200, map[string]string{"message": "会话已关联到当前任务"})
}

func (a *App) resumeSessionHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.chatBusy(r.PathValue("session")) {
		writeError(w, 409, "此会话正在页面运行，请先停止或等待完成，再打开终端继续")
		return
	}
	p, err := a.makeLaunchPlan(r, r.PathValue("id"))
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, 404, "任务不存在")
		return
	}
	if err != nil {
		writeError(w, 409, err.Error())
		return
	}
	var id string
	err = a.db.QueryRow(`SELECT session_id FROM requirement_sessions WHERE requirement_id=? AND session_id=?`, r.PathValue("id"), r.PathValue("session")).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, 404, "会话未关联到该任务，请先关联")
		return
	}
	if err != nil {
		dbError(w, err)
		return
	}
	c, err := a.openSessions(r.Context())
	if err != nil {
		writeError(w, 503, err.Error())
		return
	}
	s, err := readSession(c, id)
	c.close()
	if err != nil {
		writeError(w, 409, "会话暂不可继续："+err.Error())
		return
	}
	if !absoluteWorkspacePath(s.Cwd) {
		writeError(w, 409, "会话工作目录不是绝对路径")
		return
	}
	if info, err := workspaceStat(r.Context(), s.Cwd, true); err != nil || !info.IsDir() {
		writeError(w, 409, "会话原工作目录不可用，请恢复目录后重试")
		return
	}
	dirs := append([]string{p.Cwd}, p.AdditionalDirectories...)
	p.Cwd = s.Cwd
	p.Session = id
	if a.busyWorkspace(id, p.Cwd) {
		writeError(w, 409, "此会话或工作目录正在侧栏运行，请先等待完成")
		return
	}
	if err := a.launchConflict(id, p.Cwd); err != nil {
		writeError(w, 409, err.Error())
		return
	}
	p.AdditionalDirectories = []string{}
	p.Args = []string{"resume", id, "--cd", p.Cwd}
	for _, dir := range dirs {
		if !sameWorkspacePath(dir, p.Cwd) {
			p.AdditionalDirectories = append(p.AdditionalDirectories, dir)
			p.Args = append(p.Args, "--add-dir", dir)
		}
	}
	parts := []string{"codex"}
	for _, arg := range p.Args {
		parts = append(parts, shellQuote(arg))
	}
	p.Command = strings.Join(parts, " ")
	if a.readOnlySessions {
		p.Command = displayCommand("codex", p.Args, a.workspace == nil && nativeWindows())
	}
	p.Title = "Codex · " + sessionName(s)
	a.launchCodexPlan(w, p)
}
