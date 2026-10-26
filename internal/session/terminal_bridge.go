package session

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gorilla/websocket"

	"worktree-hub/internal/codex"
)

// Each managed TUI uses a private relay. Revocation gates requests before the
// sidebar is enabled; resuming a thread alone never grants exclusive ownership.
type terminalBridge struct {
	mu                                     sync.Mutex
	writeMu                                sync.Mutex
	app                                    *Service
	requirement, session, cwd, dir, socket string
	additionalDirectories                  []string
	sandbox                                json.RawMessage
	listener                               net.Listener
	peer                                   *os.Process
	client, upstream                       *websocket.Conn
	pending                                map[string]bridgeCall
	active, connected, draining, revoked   bool
	waiting                                bool
	bound                                  bool
	once                                   sync.Once
	done                                   chan struct{}
}
type bridgeCall struct {
	Method, Thread string
	ObservedAt     int64
}
type bridgePeerKey struct{}

func (a *Service) NewTerminalBridge(requirement, cwd string) (*terminalBridge, error) {
	dir, err := os.MkdirTemp("", "worktree-hub-terminal-")
	if err != nil {
		return nil, err
	}
	b := &terminalBridge{app: a, requirement: requirement, cwd: cwd, dir: dir, socket: filepath.Join(dir, "control.sock"), pending: map[string]bridgeCall{}, done: make(chan struct{})}
	listener, err := net.Listen("unix", b.socket)
	if err != nil {
		os.RemoveAll(dir)
		return nil, err
	}
	b.listener = listener
	if err := os.Chmod(b.socket, 0600); err != nil {
		b.Close()
		return nil, err
	}
	a.bridgeMu.Lock()
	a.bridges[b.socket] = b
	a.bridgeMu.Unlock()
	srv := &http.Server{ReadHeaderTimeout: 5 * time.Second, Handler: http.HandlerFunc(b.serve), ConnContext: func(ctx context.Context, c net.Conn) context.Context {
		return bridgePeerContext(ctx, c)
	}}
	go func() { _ = srv.Serve(listener) }()
	go b.watchLaunch(30 * time.Second)
	return b, nil
}

// Windows launchers can accept a request without ever opening Codex. A script
// that exits before connecting releases its reservation; a missing launch has
// a bounded deadline. Neither case should be reported as a connected terminal.
func (b *terminalBridge) watchLaunch(timeout time.Duration) {
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()
	for {
		expired := false
		select {
		case <-b.done:
			return
		case <-deadline.C:
			expired = true
		case <-tick.C:
		}
		_, err := os.Stat(filepath.Join(b.dir, "launch-finished"))
		b.mu.Lock()
		if b.connected || b.revoked {
			b.mu.Unlock()
			return
		}
		if expired || err == nil {
			b.revoked = true
			b.mu.Unlock()
			b.Close()
			return
		}
		b.mu.Unlock()
	}
}

func (b *terminalBridge) Close() {
	b.once.Do(func() {
		if b.done != nil {
			close(b.done)
		}
		b.mu.Lock()
		b.revoked = true
		c, u := b.client, b.upstream
		b.mu.Unlock()
		if c != nil {
			_ = c.Close()
		}
		if u != nil {
			_ = u.Close()
		}
		if b.listener != nil {
			_ = b.listener.Close()
		}
		if b.dir != "" {
			_ = os.RemoveAll(b.dir)
		}
		if b.app != nil && b.socket != "" {
			b.app.bridgeMu.Lock()
			delete(b.app.bridges, b.socket)
			b.app.bridgeMu.Unlock()
		}
	})
}
func (a *Service) CloseBridges() {
	a.bridgeMu.Lock()
	all := []*terminalBridge{}
	for _, b := range a.bridges {
		all = append(all, b)
	}
	a.bridgeMu.Unlock()
	for _, b := range all {
		b.Close()
	}
}
func (a *Service) BridgeFor(session string) *terminalBridge {
	a.bridgeMu.Lock()
	defer a.bridgeMu.Unlock()
	for _, b := range a.bridges {
		b.mu.Lock()
		match := b.session == session && b.connected && b.bound && !b.revoked
		b.mu.Unlock()
		if match {
			return b
		}
	}
	return nil
}
func (b *terminalBridge) serve(w http.ResponseWriter, r *http.Request) {
	pid, _ := r.Context().Value(bridgePeerKey{}).(int)
	name, err := os.ReadFile(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil || strings.TrimSpace(string(name)) != "codex" {
		http.Error(w, "仅允许本机 Codex 终端连接", 403)
		return
	}
	peer, err := os.FindProcess(pid)
	if err != nil {
		http.Error(w, "无法核实终端进程", 403)
		return
	}
	b.mu.Lock()
	if b.connected || b.revoked {
		b.mu.Unlock()
		peer.Release()
		http.Error(w, "此终端连接已被使用或交接", 409)
		return
	}
	b.connected = true
	b.peer = peer
	b.mu.Unlock()
	defer peer.Release()
	defer b.Close()
	up, err := codex.DialDaemon(r.Context())
	if err != nil {
		http.Error(w, err.Error(), 503)
		return
	}
	client, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
	if err != nil {
		up.Close()
		return
	}
	client.SetReadLimit(16 << 20)
	up.SetReadLimit(16 << 20)
	b.mu.Lock()
	b.client = client
	b.upstream = up
	b.mu.Unlock()
	// The one-use listener cannot be reused by a reconnecting TUI after takeover.
	_ = b.listener.Close()
	go func() {
		defer b.Close()
		for {
			_, raw, err := up.ReadMessage()
			if err != nil {
				return
			}
			b.observe(raw)
			if b.writeClient(raw) != nil {
				return
			}
		}
	}()
	for {
		_, raw, err := client.ReadMessage()
		if err != nil {
			return
		}
		if err := b.forward(raw); err != nil {
			return
		}
	}
}
func (b *terminalBridge) writeClient(raw []byte) error {
	b.writeMu.Lock()
	defer b.writeMu.Unlock()
	_ = b.client.SetWriteDeadline(time.Now().Add(5 * time.Second))
	return b.client.WriteMessage(websocket.TextMessage, raw)
}
func (b *terminalBridge) forward(raw []byte) error {
	b.app.controlMu.Lock()
	defer b.app.controlMu.Unlock()
	var m struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Params struct {
			ThreadID string `json:"threadId"`
		} `json:"params"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return err
	}
	b.mu.Lock()
	reason := ""
	if b.revoked {
		reason = "控制权已交给任务页侧栏，请在侧栏继续"
	} else if m.Method != "" && b.draining {
		reason = "正在等待本轮结束并切换到侧栏；请勿发送新请求。已有审批仍可回答，或在侧栏取消交接"
	}
	if m.Method != "" && m.Method != "initialize" && m.Method != "initialized" && !b.draining {
		if b.session != "" && (m.Method == "thread/start" || m.Method == "thread/fork" || (m.Params.ThreadID != "" && m.Params.ThreadID != b.session)) {
			reason = "该终端已绑定当前会话，请在任务页创建或打开其他会话"
		}
		thread := m.Params.ThreadID
		if thread == "" {
			thread = b.session
		}
		if b.app.ChatBusy(thread) {
			reason = "会话正在侧栏运行或交接，终端暂不可接入"
		}
	}
	if reason != "" {
		b.mu.Unlock()
		if len(m.ID) == 0 {
			return nil
		}
		reply, _ := json.Marshal(map[string]any{"id": m.ID, "error": map[string]any{"code": -32000, "message": reason}})
		return b.writeClient(reply)
	}
	if m.Method != "" && len(m.ID) > 0 {
		if m.Method == "turn/start" && len(b.additionalDirectories) > 0 {
			var err error
			raw, err = b.withWorkspaceRoots(raw)
			if err != nil {
				b.mu.Unlock()
				return err
			}
		}
		b.pending[string(m.ID)] = bridgeCall{Method: m.Method, Thread: m.Params.ThreadID, ObservedAt: time.Now().UnixNano()}
	}
	// Replies to existing approvals have no method and remain usable while draining.
	_ = b.upstream.SetWriteDeadline(time.Now().Add(5 * time.Second))
	err := b.upstream.WriteMessage(websocket.TextMessage, raw)
	b.mu.Unlock()
	return err
}

// Called under mu. Use the policy returned by thread/start or thread/resume
// unless the TUI explicitly supplies one. Preserve all existing permissions;
// only workspace-write policies can receive the verified task directories.
func (b *terminalBridge) withWorkspaceRoots(raw []byte) ([]byte, error) {
	var message map[string]json.RawMessage
	if err := json.Unmarshal(raw, &message); err != nil {
		return nil, err
	}
	var params map[string]json.RawMessage
	if err := json.Unmarshal(message["params"], &params); err != nil {
		return nil, err
	}
	policy := params["sandboxPolicy"]
	if len(policy) == 0 || string(policy) == "null" {
		policy = b.sandbox
	}
	var sandbox map[string]json.RawMessage
	if len(policy) == 0 {
		return raw, nil
	}
	if err := json.Unmarshal(policy, &sandbox); err != nil {
		return nil, err
	}
	if string(sandbox["type"]) != `"workspaceWrite"` {
		return raw, nil
	}
	var roots []string
	if v := sandbox["writableRoots"]; len(v) > 0 {
		if err := json.Unmarshal(v, &roots); err != nil {
			return nil, err
		}
	}
	seen := make(map[string]bool, len(roots))
	for _, root := range roots {
		seen[root] = true
	}
	for _, root := range append([]string{b.cwd}, b.additionalDirectories...) {
		if !seen[root] {
			roots = append(roots, root)
			seen[root] = true
		}
	}
	sandbox["writableRoots"], _ = json.Marshal(roots)
	params["sandboxPolicy"], _ = json.Marshal(sandbox)
	message["params"], _ = json.Marshal(params)
	return json.Marshal(message)
}

func (b *terminalBridge) observe(raw []byte) {
	var m struct {
		ID     json.RawMessage `json:"id"`
		Method string          `json:"method"`
		Error  json.RawMessage `json:"error"`
		Result struct {
			Sandbox json.RawMessage `json:"sandbox"`
			Thread  struct {
				codex.Session
				Status struct {
					Type        string   `json:"type"`
					ActiveFlags []string `json:"activeFlags"`
				} `json:"status"`
			} `json:"thread"`
		} `json:"result"`
		Params struct {
			ThreadID string `json:"threadId"`
			Status   struct {
				Type        string   `json:"type"`
				ActiveFlags []string `json:"activeFlags"`
			} `json:"status"`
		} `json:"params"`
	}
	if json.Unmarshal(raw, &m) != nil {
		return
	}
	var save *codex.Session
	var titleObservedAt int64
	var directories []string
	b.mu.Lock()
	if m.Method == "" {
		call, ok := b.pending[string(m.ID)]
		delete(b.pending, string(m.ID))
		if ok && len(m.Error) == 0 {
			if call.Method == "thread/start" || call.Method == "thread/resume" {
				s := m.Result.Thread.Session
				if s.ID != "" {
					b.session = s.ID
					b.bound = true
					b.sandbox = append(json.RawMessage{}, m.Result.Sandbox...)
					b.active = m.Result.Thread.Status.Type == "active"
					b.waiting = slices.Contains(m.Result.Thread.Status.ActiveFlags, "waitingOnApproval") || slices.Contains(m.Result.Thread.Status.ActiveFlags, "waitingOnUserInput")
					save = &s
					titleObservedAt = call.ObservedAt
					directories = append([]string{}, b.additionalDirectories...)
				}
			}
			if call.Method == "turn/start" {
				b.active = true
				b.waiting = false
			}
		}
	}
	if m.Params.ThreadID == b.session && b.session != "" {
		if m.Method == "turn/started" {
			b.active = true
			b.waiting = false
		}
		if m.Method == "turn/completed" {
			b.active = false
			b.waiting = false
		}
		if m.Method == "thread/status/changed" {
			b.active = m.Params.Status.Type == "active"
			b.waiting = slices.Contains(m.Params.Status.ActiveFlags, "waitingOnApproval") || slices.Contains(m.Params.Status.ActiveFlags, "waitingOnUserInput")
		}
	}
	b.mu.Unlock()
	if save != nil {
		b.app.Workspace.Mu.Lock()
		if err := b.app.SaveSession("", *save, "workspace", titleObservedAt); err == nil {
			_ = b.app.Workspace.Store.SaveSessionDirectories(save.ID, directories)
		}
		b.app.Workspace.Mu.Unlock()
	}
}

// Revoke only after the server is idle and all previously forwarded requests
// have replied. No turn/interrupt, SIGSTOP, or process signal is sent while busy.
func (b *terminalBridge) handoff(ctx context.Context, check func() (bool, error)) error {
	b.mu.Lock()
	if b.revoked {
		b.mu.Unlock()
		return fmt.Errorf("终端连接已结束，请刷新会话状态")
	}
	b.draining = true
	b.mu.Unlock()
	success := false
	defer func() {
		if !success {
			b.mu.Lock()
			b.draining = false
			b.mu.Unlock()
		}
	}()
	tick := time.NewTicker(200 * time.Millisecond)
	defer tick.Stop()
	for {
		b.mu.Lock()
		ready := !b.active && len(b.pending) == 0
		revoked := b.revoked
		b.mu.Unlock()
		if revoked {
			return fmt.Errorf("终端连接已断开，未确认交接；请刷新状态后重试")
		}
		if ready {
			idle, err := check()
			if err != nil {
				return err
			}
			if idle {
				if err := ctx.Err(); err != nil {
					return err
				}
				b.mu.Lock()
				ready = !b.active && len(b.pending) == 0
				if ready {
					b.revoked = true
				}
				peer := b.peer
				b.mu.Unlock()
				if ready {
					// The relay is already gated; disconnecting cannot interrupt a turn.
					if peer != nil {
						_ = peer.Signal(syscall.SIGTERM)
					}
					b.Close()
					success = true
					return nil
				}
			}
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("交接等待已取消，终端继续保有控制权")
		case <-tick.C:
		}
	}
}
