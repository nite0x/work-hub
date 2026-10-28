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

type TurnSettings struct {
	Model      string `json:"model,omitempty"`
	Effort     string `json:"effort,omitempty"`
	Mode       string `json:"mode,omitempty"`
	Permission string `json:"permission,omitempty"`
}

func newConversationSettings(settings TurnSettings) TurnSettings {
	if settings.Permission == "" {
		settings.Permission = "full"
	}
	if settings.Model == "" {
		settings.Model = "gpt-6.1-sol"
	}
	if settings.Model == "gpt-6.1-sol" && settings.Effort == "" {
		settings.Effort = "high"
	}
	return settings
}

func (s TurnSettings) validate() error {
	if s.Permission != "" && s.Permission != "ask" && s.Permission != "auto" && s.Permission != "full" {
		return fmt.Errorf("不支持的权限模式")
	}
	if len(s.Model) > 200 {
		return fmt.Errorf("模型名称过长")
	}
	if s.Mode != "" && s.Mode != "plan" && s.Mode != "default" {
		return fmt.Errorf("不支持的工作模式")
	}
	if s.Effort != "" && !strings.Contains("|none|minimal|low|medium|high|xhigh|max|ultra|", "|"+s.Effort+"|") {
		return fmt.Errorf("不支持的思考强度")
	}
	return nil
}

type ChatContext struct {
	Model                 string   `json:"model"`
	Effort                string   `json:"reasoningEffort"`
	Mode                  string   `json:"mode,omitempty"`
	Cwd                   string   `json:"cwd"`
	ApprovalPolicy        any      `json:"approvalPolicy,omitempty"`
	ApprovalsReviewer     string   `json:"approvalsReviewer,omitempty"`
	Sandbox               any      `json:"sandbox,omitempty"`
	AdditionalDirectories []string `json:"additional_directories"`
}
type chatModel struct {
	ID            string `json:"id"`
	Model         string `json:"model"`
	Name          string `json:"displayName"`
	Default       bool   `json:"isDefault"`
	DefaultEffort string `json:"defaultReasoningEffort"`
	Efforts       []struct {
		Effort string `json:"reasoningEffort"`
	} `json:"supportedReasoningEfforts"`
}

func listChatModels(call func(string, any, any) error) ([]chatModel, error) {
	models := []chatModel{}
	params := map[string]any{}
	seen := map[string]bool{}
	for {
		var page struct {
			Data []chatModel `json:"data"`
			Next *string     `json:"nextCursor"`
		}
		if err := call("model/list", params, &page); err != nil {
			return nil, err
		}
		models = append(models, page.Data...)
		if page.Next == nil {
			return models, nil
		}
		if seen[*page.Next] {
			return nil, fmt.Errorf("模型分页未前进")
		}
		seen[*page.Next] = true
		params["cursor"] = *page.Next
	}
}
func (a *Service) ChatOptionsHandler(w http.ResponseWriter, r *http.Request) {
	c, err := a.openSessions(r.Context())
	if err != nil {
		httpx.WriteError(w, 503, err.Error())
		return
	}
	defer c.Close()
	models, err := listChatModels(c.Call)
	if err != nil {
		httpx.WriteError(w, 503, "无法读取可用模型："+err.Error())
		return
	}
	var modes struct {
		Data []struct {
			Mode string `json:"mode"`
		} `json:"data"`
	}
	modeNames := []string{}
	if c.Call("collaborationMode/list", map[string]any{}, &modes) == nil {
		for _, m := range modes.Data {
			if m.Mode == "plan" || m.Mode == "default" {
				modeNames = append(modeNames, m.Mode)
			}
		}
	}
	httpx.WriteJSON(w, 200, map[string]any{"models": models, "modes": modeNames})
}
func (a *Service) ChatContextHandler(w http.ResponseWriter, r *http.Request) {
	record, ok := a.requestSession(w, r)
	if !ok {
		return
	}
	c, err := a.openSessions(r.Context())
	if err != nil {
		httpx.WriteError(w, 503, err.Error())
		return
	}
	defer c.Close()
	s, err := readSession(c, record.ID)
	if err != nil {
		httpx.WriteError(w, 503, err.Error())
		return
	}
	// Reading a context must never resume or mutate a thread owned by another client.
	result := ChatContext{Model: s.Model, Effort: s.Effort, Cwd: s.Cwd, AdditionalDirectories: record.AdditionalDirectories}
	if run := a.ChatFor(record.ID); run != nil {
		state := run.snapshot()
		if state.Context != nil && state.Busy {
			result = *state.Context
		}
	}
	httpx.WriteJSON(w, 200, result)
}
func (a *Service) applyTurnSettings(ctx context.Context, c codex.LiveClient, params map[string]any, settings TurnSettings, currentModel, currentEffort string) error {
	if err := settings.validate(); err != nil {
		return err
	}
	if settings.Model == "" && settings.Effort == "" && settings.Mode == "" {
		return nil
	}
	call := func(method string, p any, out any) error {
		ctx, end := context.WithTimeout(ctx, 10*time.Second)
		defer end()
		return c.Call(ctx, method, p, out)
	}
	models, err := listChatModels(call)
	if err != nil {
		return fmt.Errorf("无法核对模型设置：%w", err)
	}
	model := settings.Model
	if model == "" {
		model = currentModel
	}
	if model == "" {
		for _, m := range models {
			if m.Default {
				model = m.Model
				break
			}
		}
	}
	var selected *chatModel
	for i := range models {
		if models[i].Model == model {
			selected = &models[i]
			break
		}
	}
	if selected == nil {
		return fmt.Errorf("当前模型不可用，请重新选择模型")
	}
	if settings.Effort != "" {
		valid := false
		for _, e := range selected.Efforts {
			valid = valid || e.Effort == settings.Effort
		}
		if !valid {
			return fmt.Errorf("所选模型不支持该思考强度")
		}
	}
	if settings.Model != "" {
		params["model"] = model
	}
	if settings.Effort != "" {
		params["effort"] = settings.Effort
	}
	if settings.Model != "" && settings.Model != currentModel && settings.Effort == "" {
		params["effort"] = selected.DefaultEffort
	}
	if settings.Mode != "" {
		var modes struct {
			Data []struct {
				Mode string `json:"mode"`
			} `json:"data"`
		}
		if err := call("collaborationMode/list", map[string]any{}, &modes); err != nil {
			return fmt.Errorf("无法核对工作模式：%w", err)
		}
		supported := false
		for _, m := range modes.Data {
			supported = supported || m.Mode == settings.Mode
		}
		if !supported {
			return fmt.Errorf("当前 Codex 不支持所选工作模式")
		}
		var effort any = selected.DefaultEffort
		if settings.Effort != "" {
			effort = settings.Effort
		} else if settings.Model == "" || settings.Model == currentModel {
			for _, e := range selected.Efforts {
				if e.Effort == currentEffort {
					effort = currentEffort
					break
				}
			}
		}
		params["collaborationMode"] = map[string]any{"mode": settings.Mode, "settings": map[string]any{"model": model, "reasoning_effort": effort, "developer_instructions": nil}}
	}
	return nil
}

// Steer receipts are stored before the RPC. An ambiguous transport failure must
// never cause an automatic duplicate input, even after a backend restart.
func (a *Service) ChatSteerHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	var input struct {
		Text      string   `json:"text"`
		Images    []string `json:"images"`
		RequestID string   `json:"request_id"`
		TurnID    string   `json:"turn_id"`
	}
	if !httpx.DecodeLimit(w, r, &input, chatRequestLimit) {
		return
	}
	input.Text = strings.TrimSpace(input.Text)
	if input.RequestID == "" || len(input.RequestID) > 100 || input.TurnID == "" || len(input.TurnID) > 200 || (input.Text == "" && len(input.Images) == 0) || len(input.Text) > 64000 {
		httpx.WriteError(w, 400, "请输入补充消息并提供当前轮次及发送标识")
		return
	}
	if err := validateChatImages(input.Images); err != nil {
		httpx.WriteError(w, 400, err.Error())
		return
	}
	record, ok := a.requestSession(w, r)
	if !ok {
		return
	}
	raw, _ := json.Marshal(input)
	fingerprint := fmt.Sprintf("%x", sha256.Sum256(raw))
	var previous, status string
	err := a.Workspace.Store.DB.QueryRow(`SELECT fingerprint,status FROM conversation_input_requests WHERE session_id=? AND request_id=?`, record.ID, input.RequestID).Scan(&previous, &status)
	run := a.ChatFor(record.ID)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		httpx.DbError(w, err)
		return
	}
	if err == nil {
		if previous != fingerprint {
			httpx.WriteError(w, 409, "发送标识已用于其他补充消息")
			return
		}
		if status != "accepted" {
			httpx.WriteError(w, 409, "补充消息的投递结果未确认，请查看历史后再操作，不会自动重复投递")
			return
		}
		state := ChatState{Status: "idle", Entries: []HistoryEntry{}, Approvals: []ChatApproval{}}
		if run != nil {
			state = run.snapshot()
		}
		httpx.WriteJSON(w, 200, map[string]any{"chat": state, "accepted": input.RequestID})
		return
	}
	if run == nil {
		httpx.WriteError(w, 409, "本轮已结束，请作为下一条消息发送")
		return
	}
	state := run.snapshot()
	if !state.Busy || state.TurnID != input.TurnID || (state.Status != "running" && state.Status != "waiting") {
		httpx.WriteError(w, 409, "当前轮次已变化，请刷新状态后发送")
		return
	}
	run.mu.Lock()
	client := run.client
	run.mu.Unlock()
	if client == nil {
		httpx.WriteError(w, 409, "会话仍在连接，请稍后发送")
		return
	}
	if _, err := a.Workspace.Store.DB.Exec(`INSERT INTO conversation_input_requests(session_id,request_id,fingerprint,status) VALUES(?,?,?,'pending')`, record.ID, input.RequestID, fingerprint); err != nil {
		httpx.DbError(w, err)
		return
	}
	ctx, end := context.WithTimeout(r.Context(), 15*time.Second)
	defer end()
	var result struct {
		TurnID string `json:"turnId"`
	}
	if err := client.Call(ctx, "turn/steer", map[string]any{"threadId": record.ID, "expectedTurnId": input.TurnID, "clientUserMessageId": input.RequestID, "input": chatTurnInput(input.Text, input.Images)}, &result); err != nil || result.TurnID != input.TurnID {
		httpx.WriteError(w, 409, "补充消息未确认，请检查历史后再操作；草稿已保留")
		return
	}
	if _, err := a.Workspace.Store.DB.Exec(`UPDATE conversation_input_requests SET status='accepted' WHERE session_id=? AND request_id=?`, record.ID, input.RequestID); err != nil {
		httpx.DbError(w, err)
		return
	}
	run.change(func(s *ChatState) { s.AcceptedInputs = append(s.AcceptedInputs, input.RequestID) })
	httpx.WriteJSON(w, 200, map[string]any{"chat": run.snapshot(), "accepted": input.RequestID})
}
