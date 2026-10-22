package main

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
)

type liveEvent struct {
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
type liveClient interface {
	call(context.Context, string, any, any) error
	reply(json.RawMessage, any) error
	events() <-chan liveEvent
	close()
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
	updates  chan liveEvent
	once     sync.Once
}

func openLiveCodex(ctx context.Context) (liveClient, error) {
	conn, err := dialCodexDaemon(ctx)
	if err != nil {
		return nil, err
	}
	return startLiveWebSocket(ctx, conn)
}

// A terminal bridge forwards the TUI handshake itself; sidebar clients initialize here.
func dialCodexDaemon(ctx context.Context) (*websocket.Conn, error) {
	// CLI sessions and the web client must use the same runtime. An isolated
	// `codex app-server` cannot report whether a terminal owns an active turn.
	startup, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	start := codexCommand(startup, "app-server", "daemon", "start")
	hideCommand(start)
	err := start.Run()
	if err != nil {
		return nil, fmt.Errorf("无法连接 Codex 共享后台服务，请确认 CLI 支持 app-server daemon：%w", err)
	}
	version := codexCommand(startup, "app-server", "daemon", "version")
	hideCommand(version)
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

func startLiveWebSocket(parent context.Context, conn *websocket.Conn) (liveClient, error) {
	return startLiveWebSocketWithCapabilities(parent, conn, nil)
}

func startLiveWebSocketWithCapabilities(parent context.Context, conn *websocket.Conn, capabilities any) (liveClient, error) {
	ctx, cancel := context.WithCancel(parent)
	w := &liveWire{conn: conn, ctx: ctx, cancel: cancel, pending: map[string]chan liveResponse{}, updates: make(chan liveEvent, 256)}
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
	if err := w.call(initCtx, "initialize", params, nil); err != nil {
		w.close()
		return nil, err
	}
	if err := w.write(map[string]any{"method": "initialized"}); err != nil {
		w.close()
		return nil, err
	}
	return w, nil
}

func startLiveWire(parent context.Context, cmd *exec.Cmd) (liveClient, error) {
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
	w := &liveWire{cmd: cmd, in: in, ctx: ctx, cancel: cancel, pending: map[string]chan liveResponse{}, updates: make(chan liveEvent, 256)}
	go func() { <-ctx.Done(); _ = cmd.Process.Kill() }()
	go w.read(out)
	callCtx, end := context.WithTimeout(ctx, 10*time.Second)
	defer end()
	if err := w.call(callCtx, "initialize", map[string]any{"clientInfo": map[string]string{"name": "worktree_hub", "version": "0.1.0"}}, nil); err != nil {
		w.close()
		return nil, err
	}
	if err := w.write(map[string]any{"method": "initialized"}); err != nil {
		w.close()
		return nil, err
	}
	return w, nil
}
func (w *liveWire) events() <-chan liveEvent { return w.updates }
func (w *liveWire) close() {
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
func (w *liveWire) reply(id json.RawMessage, result any) error {
	return w.write(map[string]any{"id": id, "result": result})
}
func (w *liveWire) call(ctx context.Context, method string, params any, result any) error {
	_, err := w.callOrdered(ctx, method, params, result)
	return err
}
func (w *liveWire) callOrdered(ctx context.Context, method string, params any, result any) (uint64, error) {
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
		liveEvent
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
		case w.updates <- message.liveEvent:
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
