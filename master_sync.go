package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
	_ "time/tzdata"
)

const masterSyncTimezone = "Asia/Shanghai"

type MasterSyncSettings struct {
	Enabled bool   `json:"enabled"`
	Time    string `json:"time"`
}

type MasterSyncResult struct {
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
	Status      string `json:"status"`
	Message     string `json:"message"`
}

type MasterSyncRun struct {
	Date       string             `json:"date"`
	StartedAt  string             `json:"started_at"`
	FinishedAt string             `json:"finished_at"`
	Status     string             `json:"status"`
	Results    []MasterSyncResult `json:"results"`
}

type MasterSyncState struct {
	Settings MasterSyncSettings `json:"settings"`
	Timezone string             `json:"timezone"`
	NextRun  string             `json:"next_run,omitempty"`
	LastRun  *MasterSyncRun     `json:"last_run"`
}

func (a *App) masterSyncSettings() (MasterSyncSettings, error) {
	s := MasterSyncSettings{Enabled: true, Time: "09:00"}
	var raw string
	err := a.db.QueryRow(`SELECT value FROM settings WHERE key='master_sync'`).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	err = json.Unmarshal([]byte(raw), &s)
	return s, err
}

func masterSyncDue(s MasterSyncSettings, at time.Time) time.Time {
	zone, _ := time.LoadLocation(masterSyncTimezone) // Bundled tzdata also works on minimal hosts.
	local := at.In(zone)
	clock, _ := time.Parse("15:04", s.Time)
	return time.Date(local.Year(), local.Month(), local.Day(), clock.Hour(), clock.Minute(), 0, 0, zone)
}

func (a *App) masterSyncState(at time.Time) (MasterSyncState, error) {
	s, err := a.masterSyncSettings()
	v := MasterSyncState{Settings: s, Timezone: masterSyncTimezone}
	if err != nil {
		return v, err
	}
	var run MasterSyncRun
	var raw string
	err = a.db.QueryRow(`SELECT date,started_at,finished_at,status,results FROM master_sync_runs ORDER BY date DESC LIMIT 1`).Scan(&run.Date, &run.StartedAt, &run.FinishedAt, &run.Status, &raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return v, err
	}
	if err == nil {
		if err := json.Unmarshal([]byte(raw), &run.Results); err != nil {
			return v, err
		}
		v.LastRun = &run
	}
	if s.Enabled {
		due := masterSyncDue(s, at)
		if v.LastRun != nil && v.LastRun.Date >= due.Format("2006-01-02") {
			due = due.AddDate(0, 0, 1)
		}
		v.NextRun = due.Format(time.RFC3339)
	}
	return v, nil
}

func (a *App) masterSyncSettingsHandler(w http.ResponseWriter, r *http.Request) {
	var s MasterSyncSettings
	if !decode(w, r, &s) {
		return
	}
	clock, err := time.Parse("15:04", s.Time)
	if err != nil || clock.Format("15:04") != s.Time {
		writeError(w, 400, "请输入北京时间，格式为 HH:MM（例如 09:00）")
		return
	}
	raw, _ := json.Marshal(s)
	if _, err := a.db.Exec(`INSERT INTO settings(key,value) VALUES('master_sync',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, string(raw)); err != nil {
		dbError(w, err)
		return
	}
	writeJSON(w, 200, s)
}

// The scheduler belongs to the service, so closing a browser has no effect.
// Claim each local calendar day durably before Git runs; restarts never replay it.
func (a *App) startMasterSync(parent context.Context) func() {
	if a.workspace != nil {
		parent = withWorkspace(parent, a.workspace)
	}
	ctx, cancel := context.WithCancel(parent)
	done := make(chan struct{})
	go func() {
		defer close(done)
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			if ctx.Err() != nil {
				return
			}
			if err := a.runDailyMasterSync(ctx, time.Now()); err != nil {
				log.Printf("master 每日更新：%s", redactGitOutput(err.Error()))
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return func() { cancel(); <-done }
}

func (a *App) saveMasterSyncRun(run MasterSyncRun) error {
	raw, err := json.Marshal(run.Results)
	if err != nil {
		return err
	}
	_, err = a.db.Exec(`UPDATE master_sync_runs SET finished_at=?,status=?,results=? WHERE date=?`, run.FinishedAt, run.Status, string(raw), run.Date)
	return err
}

func (a *App) runDailyMasterSync(ctx context.Context, at time.Time) error {
	if !a.masterSyncMu.TryLock() {
		return nil
	}
	defer a.masterSyncMu.Unlock()
	s, err := a.masterSyncSettings()
	if err != nil || !s.Enabled {
		return err
	}
	due := masterSyncDue(s, at)
	if at.Before(due) || ctx.Err() != nil {
		return nil
	}
	projects, err := a.projects()
	if err != nil || len(projects) == 0 {
		return err
	}
	run := MasterSyncRun{Date: due.Format("2006-01-02"), StartedAt: now(), Status: "running", Results: []MasterSyncResult{}}
	for _, p := range projects {
		run.Results = append(run.Results, MasterSyncResult{ProjectID: p.ID, ProjectName: p.Name, Status: "pending", Message: "等待更新"})
	}
	raw, _ := json.Marshal(run.Results)
	claimed, err := a.db.Exec(`INSERT OR IGNORE INTO master_sync_runs(date,started_at,finished_at,status,results) VALUES(?,?,'','running',?)`, run.Date, run.StartedAt, string(raw))
	if err != nil {
		return err
	}
	n, err := claimed.RowsAffected()
	if err != nil || n == 0 {
		return err
	}
	for i, p := range projects {
		if ctx.Err() != nil {
			break
		}
		// Share the mutation lock with worktree creation and manual Git actions.
		a.mu.Lock()
		projectCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		status, message, syncErr := a.syncProjectMaster(projectCtx, p.ID)
		cancel()
		a.mu.Unlock()
		if syncErr != nil {
			status, message = "failed", redactGitOutput(syncErr.Error())
		}
		run.Results[i].Status, run.Results[i].Message = status, message
		a.stateCache.invalidate()
		if err := a.saveMasterSyncRun(run); err != nil {
			return err
		}
	}
	run.Status, run.FinishedAt = "completed", now()
	if ctx.Err() != nil {
		run.Status = "interrupted"
	}
	return a.saveMasterSyncRun(run)
}

func (a *App) syncProjectMaster(ctx context.Context, id string) (string, string, error) {
	p, err := a.registeredProject(ctx, id)
	if err != nil {
		return "", "", err
	}
	old, err := git(ctx, p.Path, "rev-parse", "--verify", "refs/heads/master^{commit}")
	if err != nil {
		return "skipped", "缺少本地 master，请在 Git 操作中准备 master 分支", nil
	}
	old = strings.TrimSpace(old)
	remote, _ := git(ctx, p.Path, "config", "--get", "branch.master.remote")
	merge, _ := git(ctx, p.Path, "config", "--get-all", "branch.master.merge")
	remote, merge = strings.TrimSpace(remote), strings.TrimSpace(merge)
	if merge != "" && merge != "refs/heads/master" {
		return "skipped", "master 的 upstream 不是远端 master，请检查跟踪配置", nil
	}
	remotes, err := git(ctx, p.Path, "remote")
	if err != nil {
		return "", "", err
	}
	names := strings.Fields(remotes)
	if remote == "" {
		for _, name := range names {
			if name == "origin" || len(names) == 1 {
				remote = name
			}
		}
	}
	found := false
	for _, name := range names {
		found = found || name == remote
	}
	if !found || strings.HasPrefix(remote, "-") {
		return "skipped", "无法确定 master 的远端；请配置 upstream 或 origin", nil
	}
	remoteRef := "refs/remotes/" + remote + "/master"
	if _, err := a.gitNetwork(ctx, p.Path, "fetch", "--no-tags", "--", remote, "+refs/heads/master:"+remoteRef); err != nil {
		return "", "", err
	}
	target, err := git(ctx, p.Path, "rev-parse", "--verify", remoteRef+"^{commit}")
	if err != nil {
		return "", "", err
	}
	target = strings.TrimSpace(target)
	if old == target {
		return "current", "master 已是最新", nil
	}
	if _, err := git(ctx, p.Path, "merge-base", "--is-ancestor", old, target); err != nil {
		return "skipped", "master 含本地独有提交或已与远端分歧，无法快进", nil
	}
	trees, err := scanWorktrees(ctx, p.Path)
	if err != nil {
		return "", "", err
	}
	checkedOut := 0
	for _, tree := range trees {
		if tree.Branch == "master" {
			checkedOut++
		}
	}
	if checkedOut > 1 {
		return "skipped", "master 同时在多个 worktree 检出，请先检查目录", nil
	}
	for _, tree := range trees {
		if tree.Branch != "master" {
			continue
		}
		if tree.Locked || tree.Prunable || tree.Missing || tree.Error != "" || tree.Dirty > 0 {
			return "skipped", "master 所在 worktree 有未提交修改、被锁定或不可用：" + tree.Path, nil
		}
		if _, err := selectedWorktree(ctx, p, tree.Path); err != nil {
			return "", "", err
		}
		for _, marker := range []string{"MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer", "BISECT_LOG"} {
			path, err := git(ctx, tree.Path, "rev-parse", "--path-format=absolute", "--git-path", marker)
			if err != nil {
				return "", "", err
			}
			if _, err := workspaceStat(ctx, strings.TrimSpace(path), true); !errors.Is(err, os.ErrNotExist) {
				return "skipped", "master 工作目录存在未结束的 Git 操作，请先处理：" + marker, nil
			}
		}
		current, err := git(ctx, tree.Path, "symbolic-ref", "--quiet", "HEAD")
		if err != nil || strings.TrimSpace(current) != "refs/heads/master" {
			return "skipped", "工作目录分支已变化，请稍后重试", nil
		}
		// Merge the fetched commit, never pull another upstream or autostash files.
		if _, err := gitOperation(ctx, tree.Path, "-c", "merge.autostash=false", "merge", "--ff-only", "--no-autostash", target); err != nil {
			return "", "", err
		}
		return "updated", "已快进更新 master（" + remote + "/master）", nil
	}
	// master is not checked out: advance only this ref, keeping all task files intact.
	if _, err := git(ctx, p.Path, "update-ref", "-m", "worktree-hub: daily master sync", "refs/heads/master", target, old); err != nil {
		return "", "", fmt.Errorf("master 更新失败：%w", err)
	}
	return "updated", "已快进更新 master（" + remote + "/master）", nil
}
