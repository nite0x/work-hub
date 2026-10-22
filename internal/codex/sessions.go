package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"time"

	"worktree-hub/internal/platform"
)

// Use the public app-server protocol instead of depending on Codex's private
// SQLite schema. Each connection is short
// lived, bounded by the request context, and never starts an agent turn.
type codexClient struct {
	cmd    *exec.Cmd
	in     io.WriteCloser
	out    *bufio.Scanner
	cancel context.CancelFunc
	id     int
}

type Session struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Preview     string `json:"preview"`
	Cwd         string `json:"cwd"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
	HistoryMode string `json:"historyMode,omitempty"`
}

type SessionPage struct {
	Data       []Session `json:"data"`
	NextCursor *string   `json:"nextCursor"`
}

type SessionClient interface {
	Call(string, any, any) error
	Close()
}

func OpenSessionClient(ctx context.Context) (SessionClient, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	cmd := Command(ctx, "app-server")
	platform.HideCommand(cmd)
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
		return nil, fmt.Errorf("无法读取 Codex 会话，请检查服务环境中的 Codex CLI：%w", err)
	}
	c := &codexClient{cmd: cmd, in: in, out: bufio.NewScanner(out), cancel: cancel}
	c.out.Buffer(make([]byte, 4096), 4<<20)
	if err := c.Call("initialize", map[string]any{"clientInfo": map[string]string{"name": "worktree_hub", "version": "0.1.0"}}, nil); err != nil {
		c.Close()
		return nil, err
	}
	if err := json.NewEncoder(in).Encode(map[string]any{"method": "initialized"}); err != nil {
		c.Close()
		return nil, err
	}
	return c, nil
}

func (c *codexClient) Close() {
	_ = c.in.Close()
	c.cancel()
	_ = c.cmd.Wait()
}

func (c *codexClient) Call(method string, params any, result any) error {
	c.id++
	if err := json.NewEncoder(c.in).Encode(map[string]any{"id": c.id, "method": method, "params": params}); err != nil {
		return err
	}
	for c.out.Scan() {
		var response struct {
			ID     *int            `json:"id"`
			Result json.RawMessage `json:"result"`
			Error  *struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		if err := json.Unmarshal(c.out.Bytes(), &response); err != nil {
			return fmt.Errorf("Codex 返回了无法读取的会话数据：%w", err)
		}
		if response.ID == nil || *response.ID != c.id {
			continue
		}
		if response.Error != nil {
			return fmt.Errorf("Codex 会话接口：%s", response.Error.Message)
		}
		if result == nil {
			return nil
		}
		return json.Unmarshal(response.Result, result)
	}
	if err := c.out.Err(); err != nil {
		return fmt.Errorf("读取 Codex 会话失败：%w", err)
	}
	return fmt.Errorf("Codex 会话接口已断开或超时，请确认 CLI 支持 app-server 后重试")
}
