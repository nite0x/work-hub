package session

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"worktree-hub/internal/httpx"
	"worktree-hub/internal/platform"
)

func (a *Service) DecorateHandoff(s *ChatState, session, cwd string) {
	b := a.BridgeFor(session)
	if b != nil {
		s.CanHandoff = true
		if s.Blocked != "" {
			s.Notice = "可切换到侧栏；正在运行的这一轮会先完成，期间审批仍在原终端处理"
		}
	} else if s.Blocked != "" {
		if pending := a.TerminalOwner(session, cwd); pending != nil {
			pending.mu.Lock()
			starting := !pending.connected && !pending.revoked
			pending.mu.Unlock()
			if starting {
				s.Notice = "正在等待终端连接；连接成功后可切换到侧栏。启动失败会自动释放占用，最多等待 30 秒后可重试。"
				return
			}
		}
		s.Notice = "无法准确核实终端与当前会话的归属，已阻止自动接管。请在原终端退出 Codex；以后从工作台打开的终端支持自动交接。"
	}
}
func (a *Service) ChatHandoffHandler(w http.ResponseWriter, r *http.Request) {
	a.controlMu.Lock()
	defer a.controlMu.Unlock()
	var input struct {
		RequestID string `json:"request_id"`
	}
	if !httpx.Decode(w, r, &input) {
		return
	}
	if input.RequestID == "" || len(input.RequestID) > 100 {
		httpx.WriteError(w, 400, "缺少交接标识")
		return
	}
	record, ok := a.requestSession(w, r)
	cwd := record.Cwd
	if !ok {
		return
	}
	session := r.PathValue("session")
	b := a.BridgeFor(session)
	pid := 0
	same := false
	if b != nil {
		b.mu.Lock()
		if b.peer != nil {
			pid = b.peer.Pid
		}
		same = platform.SameWorkspacePath(b.cwd, cwd)
		b.mu.Unlock()
	}
	a.chatMu.Lock()
	if old := a.chats[session]; old != nil {
		s := old.snapshot()
		if s.ID == input.RequestID {
			a.chatMu.Unlock()
			httpx.WriteJSON(w, 200, s)
			return
		}
		if s.Busy {
			a.chatMu.Unlock()
			httpx.WriteError(w, 409, "此会话已经在运行或交接")
			return
		}
	}
	if b == nil {
		a.chatMu.Unlock()
		httpx.WriteError(w, 409, "无法准确识别此会话的终端控制连接，已阻止接管。请先在原终端退出 Codex；从工作台新打开的终端支持一键交接")
		return
	}
	if !same || pid == 0 {
		a.chatMu.Unlock()
		httpx.WriteError(w, 409, "终端归属或工作目录不匹配，已阻止接管")
		return
	}
	if err := scanTerminalSessionsExcept("/proc", session, cwd, pid); err != nil {
		a.chatMu.Unlock()
		httpx.WriteError(w, 409, "发现其他无法确认归属的 Codex 终端，已阻止接管："+err.Error())
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	run := &ChatRun{session: session, cwd: cwd, handoff: true, cancel: cancel, notify: make(chan struct{}, 1), finished: make(chan struct{}), state: ChatState{ID: input.RequestID, Status: "handoff", Busy: true, Notice: "正在等待终端本轮工作结束；不会中断思考、输出或命令。审批仍在原终端处理，可取消等待。", Entries: []HistoryEntry{}, Approvals: []ChatApproval{}}}
	a.chats[session] = run
	a.chatMu.Unlock()
	go a.DriveHandoff(ctx, run, b, pid)
	httpx.WriteJSON(w, 202, run.snapshot())
}
func (a *Service) DriveHandoff(ctx context.Context, run *ChatRun, b *terminalBridge, pid int) {
	defer close(run.finished)
	defer run.cancel()
	defer func() { run.mu.Lock(); run.ended = time.Now(); run.mu.Unlock() }()
	ctx, end := context.WithTimeout(ctx, 30*time.Minute)
	defer end()
	c, err := a.openLive(ctx)
	if err == nil {
		defer c.Close()
		err = b.handoff(ctx, func() (bool, error) {
			if err := scanTerminalSessionsExcept("/proc", run.session, run.cwd, pid); err != nil {
				return false, fmt.Errorf("检测到其他终端，已取消交接：%w", err)
			}
			var metadata struct {
				Thread struct {
					ID     string `json:"id"`
					Status struct {
						Type string `json:"type"`
					} `json:"status"`
				} `json:"thread"`
			}
			callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			defer cancel()
			if err := c.Call(callCtx, "thread/read", map[string]any{"threadId": run.session, "includeTurns": false}, &metadata); err != nil {
				return false, err
			}
			if metadata.Thread.ID != run.session {
				return false, fmt.Errorf("无法核实当前会话状态，未退出终端")
			}
			switch metadata.Thread.Status.Type {
			case "idle":
				return true, nil
			case "active":
				return false, nil
			default:
				return false, fmt.Errorf("会话状态无法安全交接（%s），终端保持原状", metadata.Thread.Status.Type)
			}
		})
	}
	run.change(func(s *ChatState) {
		s.Busy = false
		s.Notice = ""
		if err != nil {
			s.Status = "conflict"
			s.Error = err.Error()
			s.Blocked = "交接未完成，请在原终端继续，或重新尝试切换到侧栏"
			if errors.Is(ctx.Err(), context.Canceled) {
				s.Status = "idle"
				s.Error = ""
				s.Notice = "已取消交接，终端继续保有控制权"
			}
		} else {
			s.Status = "idle"
			s.Notice = "已切换到侧栏，原终端连接已关闭。可以继续发送消息。"
		}
	})
}
