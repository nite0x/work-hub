package session

import (
	"net/http"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/workspace"
)

func (a *Service) UploadAttachmentHandler(w http.ResponseWriter, r *http.Request) {
	var input struct {
		Name string `json:"name"`
		Data []byte `json:"data"`
	}
	if !httpx.DecodeLimit(w, r, &input, chatRequestLimit) {
		return
	}
	if input.Data == nil {
		httpx.WriteError(w, 400, "缺少文件内容")
		return
	}
	ctx := workspace.WithClient(r.Context(), a.Workspace.Remote)
	path, err := workspace.StoreAttachment(ctx, a.Workspace.DataDir, input.Name, input.Data)
	if err != nil {
		httpx.WriteError(w, 400, "附件保存失败："+err.Error())
		return
	}
	httpx.WriteJSON(w, 200, map[string]string{"path": path})
}
