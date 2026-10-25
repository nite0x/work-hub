package app

import (
	"context"
	"net/http"
	"time"

	"worktree-hub/internal/httpx"
)

func (a *App) pickDirectoryHandler(w http.ResponseWriter, r *http.Request) {
	if id := r.Header.Get("X-Environment-ID"); (id != "" && id != "local") || a.Workspace.Remote != nil {
		httpx.WriteError(w, 422, "文件夹选择仅支持本机；WSL 项目请手动填写 Linux 绝对路径。")
		return
	}
	if a.directoryPickerBusy.Swap(true) {
		httpx.WriteError(w, 409, "已有文件夹选择窗口打开，请先完成选择。")
		return
	}
	defer a.directoryPickerBusy.Store(false)
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	path, err := a.pickDirectory(ctx)
	if err != nil {
		httpx.WriteError(w, 422, err.Error())
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"path": path})
}
