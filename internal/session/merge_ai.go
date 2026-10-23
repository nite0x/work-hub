package session

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/task"
	"worktree-hub/internal/workspace"
)

func (a *Service) mergeConflictPlan(ctx context.Context, id, project, mergeHead string) (model.LaunchPlan, string, error) {
	plan := model.LaunchPlan{}
	q, err := a.Workspace.Store.Requirement(id)
	if err != nil || q.State != "ready" {
		return plan, "", fmt.Errorf("任务尚未就绪或已归档")
	}
	ps, err := a.Workspace.Store.ProjectMap()
	if err != nil {
		return plan, "", err
	}
	for _, member := range q.Members {
		if member.ProjectID != project || member.State != "ready" {
			continue
		}
		// Validate only this member so an unrelated project's unavailable worktree
		// cannot prevent recovering this merge. Never accept a client-supplied cwd.
		member.Mode = "worktree"
		if err := task.VerifyMember(ctx, ps[project], member, ""); err != nil {
			return plan, "", err
		}
		state, err := workspace.ReadGitState(ctx, member.Path)
		if err != nil {
			return plan, "", err
		}
		if state.Operation != "merge" || mergeHead == "" || state.MergeHead != mergeHead {
			return plan, "", fmt.Errorf("合并状态已变化，请刷新后重新打开 AI")
		}
		prompt := fmt.Sprintf("请完成当前 Git 合并。\n任务：%s\n项目：%s\n工作目录：%s\n目标分支：%s\n目标 HEAD：%s\n待合入 MERGE_HEAD：%s\n当前未解决冲突文件：\n%s\n\n先读取任务说明 %s 和适用的 AGENTS.md，再核实 git status、HEAD 和 MERGE_HEAD。如果合并目标已变化或已不存在，请停止并说明。理解双方改动意图后解决全部冲突，保留双方需要的功能，按项目要求运行必要检查，仅暂存此次合并涉及的文件并完成合并提交。不要切换分支、重置或丢弃其他修改，不要推送。遇到无法判断的业务选择时向用户询问，完成后报告合并结果与验证情况。", q.Name, member.ProjectName, member.Path, state.Branch, state.Head, state.MergeHead, strings.Join(state.Conflicts, "\n"), platform.JoinWorkspacePath(q.Path, "BRIEF.md"))
		plan = model.LaunchPlan{Title: "Codex · 合并冲突 · " + member.ProjectName, Requirement: id, Cwd: member.Path, Args: []string{"--cd", member.Path, prompt}, AdditionalDirectories: []string{}}
		plan.Command = platform.DisplayCommand("codex", plan.Args, platform.NativeWindows() && a.Workspace.Remote == nil)
		return plan, prompt, nil
	}
	return plan, "", fmt.Errorf("所选项目未关联当前任务或目录尚未就绪")
}

// Read-only desktop sessions launch the existing terminal instead of using the
// interactive app-server. Persist before launch so uncertain retries cannot
// silently open a second AI that edits the same merge.
func (a *Service) MergeAIHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	if !a.Workspace.ReadOnlySessions {
		httpx.WriteError(w, 409, "请使用任务侧栏处理合并")
		return
	}
	var input struct {
		Project   string `json:"project_id"`
		MergeHead string `json:"merge_head"`
		RequestID string `json:"request_id"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if input.RequestID == "" || len(input.RequestID) > 80 {
		httpx.WriteError(w, 400, "缺少有效的启动标识")
		return
	}
	id, key := r.PathValue("id"), "merge-terminal:"+input.RequestID
	var old string
	err := a.Workspace.Store.DB.QueryRow(`SELECT session_id FROM session_create_requests WHERE requirement_id=? AND request_id=?`, id, key).Scan(&old)
	if err == nil {
		if old == "launched" {
			httpx.WriteJSON(w, 200, map[string]string{"message": "已向 Codex 终端发送合并处理请求，请查看终端"})
		} else {
			httpx.WriteError(w, 409, "上次终端启动结果未确认，请先检查终端，避免重复启动 AI")
		}
		return
	}
	if !errors.Is(err, sql.ErrNoRows) {
		httpx.DbError(w, err)
		return
	}
	plan, _, err := a.mergeConflictPlan(r.Context(), id, input.Project, input.MergeHead)
	if err != nil {
		httpx.WriteError(w, 409, err.Error())
		return
	}
	if _, err := a.Workspace.Store.DB.Exec(`INSERT INTO session_create_requests(requirement_id,request_id) VALUES(?,?)`, id, key); err != nil {
		httpx.DbError(w, err)
		return
	}
	if err := a.Workspace.LaunchSimpleTerminal(plan); err != nil {
		httpx.WriteJSON(w, 503, map[string]string{"error": "无法打开 AI 终端：" + err.Error() + "；请检查终端后手动执行命令", "command": plan.Command})
		return
	}
	if _, err := a.Workspace.Store.DB.Exec(`UPDATE session_create_requests SET session_id='launched' WHERE requirement_id=? AND request_id=?`, id, key); err != nil {
		httpx.DbError(w, err)
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"message": "已打开 Codex 终端，携带当前目录的合并上下文"})
}
