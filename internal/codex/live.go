package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"worktree-hub/internal/platform"
)

type Event struct {
	Sequence uint64          `json:"-"`
	ID       json.RawMessage `json:"id"`
	Method   string          `json:"method"`
	Params   json.RawMessage `json:"params"`
}
type liveResponse struct {
	Sequence uint64
	Result   json.RawMessage
	Err      error
}
type LiveClient interface {
	Call(context.Context, string, any, any) error
	Reply(json.RawMessage, any) error
	Events() <-chan Event
	Close()
}
type liveWire struct {
	cmd      *exec.Cmd
	in       io.WriteCloser
	conn     *websocket.Conn
	cancel   context.CancelFunc
	ctx      context.Context
	mu       sync.Mutex
	writeMu  sync.Mutex
	pending  map[string]chan liveResponse
	sequence int
	received uint64
	updates  chan Event
	once     sync.Once
}

func OpenLive(ctx context.Context) (LiveClient, error) {
	conn, err := DialDaemon(ctx)
	if err != nil {
		return nil, err
	}
	return StartWebSocket(ctx, conn)
}

// A terminal bridge forwards the TUI handshake itself; sidebar clients initialize here.
func DialDaemon(ctx context.Context) (*websocket.Conn, error) {
	// CLI sessions and the web client must use the same runtime. An isolated
	// `codex app-server` cannot report whether a terminal owns an active turn.
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	start := Command(startup, "app-server", "daemon", "start")
	platform.HideCommand(start)
	err := start.Run()
	if err != nil {
		return nil, fmt.Errorf("无法连接 Codex 共享后台服务，请确认 CLI 支持 app-server daemon：%w", err)
	}
	version := Command(startup, "app-server", "daemon", "version")
	platform.HideCommand(version)
	raw, err := version.Output()
	if err != nil {
		return nil, err
	}
	var daemon struct {
		SocketPath string `json:"socketPath"`
	}
	if err := json.Unmarshal(raw, &daemon); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(daemon.SocketPath) {
		return nil, fmt.Errorf("Codex 未返回可用的共享套接字路径")
	}
	if info, err := os.Stat(daemon.SocketPath); err != nil || info.Mode()&os.ModeSocket == 0 {
		return nil, fmt.Errorf("Codex 共享套接字不可用")
	}
	dialer := websocket.Dialer{HandshakeTimeout: 5 * time.Second, NetDialContext: func(dialCtx context.Context, _, _ string) (net.Conn, error) {
		if runtime.GOOS == "windows" {
			return dialCodexProxy(ctx, daemon.SocketPath)
		}
		return (&net.Dialer{}).DialContext(dialCtx, "unix", daemon.SocketPath)
	}}
	conn, _, err := dialer.DialContext(startup, "ws://localhost/", nil)
	if err != nil {
		return nil, fmt.Errorf("连接 Codex 共享套接字失败：%w", err)
	}
	return conn, nil
}

func StartWebSocket(parent context.Context, conn *websocket.Conn) (LiveClient, error) {
	return StartWebSocketWithCapabilities(parent, conn, map[string]bool{"mcpServerOpenaiFormElicitation": true, "experimentalApi": true})
}

func StartWebSocketWithCapabilities(parent context.Context, conn *websocket.Conn, capabilities any) (LiveClient, error) {
	ctx, cancel := context.WithCancel(parent)
	w := &liveWire{conn: conn, ctx: ctx, cancel: cancel, pending: map[string]chan liveResponse{}, updates: make(chan Event, 256)}
	conn.SetReadLimit(16 << 20)
	go func() { <-ctx.Done(); _ = conn.Close() }()
	go func() {
		defer close(w.updates)
		defer w.failPending()
		for {
			_, raw, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if !w.dispatch(raw) {
				return
			}
		}
	}()
	initCtx, end := context.WithTimeout(ctx, 10*time.Second)
	defer end()
	params := map[string]any{"clientInfo": map[string]string{"name": "worktree_hub", "version": "0.1.0"}}
	if capabilities != nil {
		params["capabilities"] = capabilities
	}
	if err := w.Call(initCtx, "initialize", params, nil); err != nil {
		w.Close()
		return nil, err
	}
	if err := w.write(map[string]any{"method": "initialized"}); err != nil {
		w.Close()
		return nil, err
	}
	return w, nil
}

func StartWire(parent context.Context, cmd *exec.Cmd) (LiveClient, error) {
	ctx, cancel := context.WithCancel(parent)
	in, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		in.Close()
		cancel()
		return nil, err
	}
	w := &liveWire{cmd: cmd, in: in, ctx: ctx, cancel: cancel, pending: map[string]chan liveResponse{}, updates: make(chan Event, 256)}
	go func() { <-ctx.Done(); _ = cmd.Process.Kill() }()
	go w.read(out)
	callCtx, end := context.WithTimeout(ctx, 10*time.Second)
	defer end()
	if err := w.Call(callCtx, "initialize", map[string]any{"clientInfo": map[string]string{"name": "worktree_hub", "version": "0.1.0"}, "capabilities": map[string]bool{"mcpServerOpenaiFormElicitation": true, "experimentalApi": true}}, nil); err != nil {
		w.Close()
		return nil, err
	}
	if err := w.write(map[string]any{"method": "initialized"}); err != nil {
		w.Close()
		return nil, err
	}
	return w, nil
}
func (w *liveWire) Events() <-chan Event { return w.updates }
func (w *liveWire) Close() {
	w.once.Do(func() {
		w.cancel()
		if w.conn != nil {
			_ = w.conn.Close()
		} else {
			_ = w.in.Close()
			_ = w.cmd.Wait()
		}
	})
}
func (w *liveWire) write(value any) error {
	w.writeMu.Lock()
	defer w.writeMu.Unlock()
	if w.conn != nil {
		_ = w.conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		return w.conn.WriteJSON(value)
	}
	return json.NewEncoder(w.in).Encode(value)
}
func (w *liveWire) Reply(id json.RawMessage, result any) error {
	return w.write(map[string]any{"id": id, "result": result})
}
func (w *liveWire) Call(ctx context.Context, method string, params any, result any) error {
	_, err := w.CallOrdered(ctx, method, params, result)
	return err
}
func (w *liveWire) CallOrdered(ctx context.Context, method string, params any, result any) (uint64, error) {
	w.mu.Lock()
	w.sequence++
	id := w.sequence
	key := strconv.Itoa(id)
	response := make(chan liveResponse, 1)
	w.pending[key] = response
	w.mu.Unlock()
	defer func() { w.mu.Lock(); delete(w.pending, key); w.mu.Unlock() }()
	if err := w.write(map[string]any{"id": id, "method": method, "params": params}); err != nil {
		return 0, err
	}
	select {
	case reply := <-response:
		if reply.Err != nil {
			return reply.Sequence, reply.Err
		}
		if result == nil {
			return reply.Sequence, nil
		}
		return reply.Sequence, json.Unmarshal(reply.Result, result)
	case <-ctx.Done():
		return 0, ctx.Err()
	case <-w.ctx.Done():
		return 0, fmt.Errorf("Codex 实时连接已断开")
	}
}
func (w *liveWire) read(out io.Reader) {
	defer close(w.updates)
	defer w.failPending()
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 4096), 16<<20)
	for scanner.Scan() {
		if !w.dispatch(scanner.Bytes()) {
			return
		}
	}
}
func (w *liveWire) dispatch(raw []byte) bool {
	var message struct {
		Event
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &message); err != nil {
		return false
	}
	w.received++
	message.Sequence = w.received
	if message.Method != "" {
		select {
		case w.updates <- message.Event:
		case <-w.ctx.Done():
			return false
		}
		return true
	}
	w.mu.Lock()
	waiting := w.pending[string(message.ID)]
	w.mu.Unlock()
	if waiting != nil {
		reply := liveResponse{Result: message.Result, Sequence: w.received}
		if message.Error != nil {
			reply.Err = fmt.Errorf("Codex：%s", message.Error.Message)
		}
		select {
		case waiting <- reply:
		default:
		}
	}
	return true
}
func (w *liveWire) failPending() {
	w.mu.Lock()
	for _, waiting := range w.pending {
		select {
		case waiting <- liveResponse{Err: fmt.Errorf("Codex 实时连接已断开，请重新打开会话检查已保存的进展")}:
		default:
		}
	}
	w.mu.Unlock()
}
