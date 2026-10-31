package workspace

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"time"

	"worktree-hub/internal/model"
	"worktree-hub/internal/platform"
)

const Protocol = 1

// ErrBusy means the helper rejected a request before executing it.
var ErrBusy = errors.New("辅助程序繁忙，请稍后重试")

type Request struct {
	ID       uint64                 `json:"id"`
	Op       string                 `json:"op"`
	Path     string                 `json:"path,omitempty"`
	Args     []string               `json:"args,omitempty"`
	Data     []byte                 `json:"data,omitempty"`
	Flags    int                    `json:"flags,omitempty"`
	Mode     uint32                 `json:"mode,omitempty"`
	Timeout  int64                  `json:"timeout_ms,omitempty"`
	Messages bool                   `json:"messages,omitempty"`
	Method   string                 `json:"method,omitempty"`
	Params   json.RawMessage        `json:"params,omitempty"`
	Plan     *model.LaunchPlan      `json:"plan,omitempty"`
	Settings model.TerminalSettings `json:"settings,omitempty"`
	CancelID uint64                 `json:"cancel_id,omitempty"`
}
type Response struct {
	More  bool            `json:"more,omitempty"`
	ID    uint64          `json:"id"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
	Code  string          `json:"code,omitempty"`
}

func (r Response) err() error {
	if r.Error == "" {
		return nil
	}
	// Recognize older helpers that did not include a machine-readable code.
	if r.Code == "busy" || r.Error == ErrBusy.Error() {
		return ErrBusy
	}
	switch r.Code {
	case "session_conflict":
		return &SessionConflictError{Message: r.Error}
	case "not_exist":
		return fmt.Errorf("%s: %w", r.Error, os.ErrNotExist)
	case "exist":
		return fmt.Errorf("%s: %w", r.Error, os.ErrExist)
	default:
		return errors.New(r.Error)
	}
}

type Identity struct {
	Protocol         int    `json:"protocol"`
	Home             string `json:"home"`
	User             string `json:"user"`
	Distro           string `json:"distro"`
	CredentialHelper string `json:"credential_helper"`
}
type Client struct {
	mu       sync.Mutex
	writeMu  sync.Mutex
	cmd      *exec.Cmd
	in       io.WriteCloser
	pending  map[uint64]chan Response
	sequence uint64
	done     chan struct{}
	once     sync.Once
	Identity Identity
}
type workspaceContextKey struct{}

func WithClient(ctx context.Context, c *Client) context.Context {
	return context.WithValue(ctx, workspaceContextKey{}, c)
}
func RemoteClient(ctx context.Context) *Client {
	c, _ := ctx.Value(workspaceContextKey{}).(*Client)
	return c
}

func StartClient(cmd *exec.Cmd) (*Client, error) {
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		in.Close()
		return nil, err
	}
	cmd.Stderr = os.Stderr
	platform.HideCommand(cmd)
	if err := cmd.Start(); err != nil {
		in.Close()
		return nil, err
	}
	c := &Client{cmd: cmd, in: in, pending: map[uint64]chan Response{}, done: make(chan struct{})}
	go func() {
		scan := bufio.NewScanner(out)
		scan.Buffer(make([]byte, 4096), 16<<20)
		for scan.Scan() {
			var response Response
			if err := json.Unmarshal(scan.Bytes(), &response); err != nil {
				break
			}
			c.mu.Lock()
			ch := c.pending[response.ID]
			if !response.More {
				delete(c.pending, response.ID)
			}
			if ch != nil {
				// Streaming responses are complete display snapshots. Coalesce a
				// slow reader's older snapshot without blocking other workspace RPCs.
				select {
				case <-ch:
				default:
				}
				ch <- response
			}
			c.mu.Unlock()
		}
		c.fail()
		_ = cmd.Wait()
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := c.Call(ctx, Request{Op: "identity"}, &c.Identity); err != nil {
		c.Close()
		return nil, err
	}
	if c.Identity.Protocol != Protocol {
		c.Close()
		return nil, fmt.Errorf("WSL 辅助程序协议不兼容，请重新安装辅助程序")
	}
	return c, nil
}
func (c *Client) fail() {
	c.once.Do(func() {
		close(c.done)
		c.mu.Lock()
		defer c.mu.Unlock()
		for id, ch := range c.pending {
			select {
			case <-ch:
			default:
			}
			ch <- Response{Error: "WSL 辅助程序连接已断开，请重新连接后检查操作结果"}
			delete(c.pending, id)
		}
	})
}
func (c *Client) Close()                { _ = c.in.Close(); c.fail() }
func (c *Client) Done() <-chan struct{} { return c.done }
func (c *Client) Call(ctx context.Context, request Request, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 100*time.Second)
	defer cancel()
	// Only retry admission failures: the helper guarantees a busy request has
	// not executed. Accepted writes and ambiguous connection failures must never
	// be replayed. Keep the original deadline across attempts.
	retryCtx, stopRetry := context.WithTimeout(ctx, 5*time.Second)
	defer stopRetry()
	for delay := 50 * time.Millisecond; ; delay = min(delay*2, 500*time.Millisecond) {
		err := c.callOnce(ctx, request, result)
		if !errors.Is(err, ErrBusy) {
			return err
		}
		timer := time.NewTimer(delay)
		select {
		case <-retryCtx.Done():
			timer.Stop()
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return err
		case <-c.done:
			timer.Stop()
			return fmt.Errorf("WSL 辅助程序未连接，请重新连接")
		case <-timer.C:
		}
	}
}

func (c *Client) callOnce(ctx context.Context, request Request, result any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	select {
	case <-c.done:
		c.mu.Unlock()
		return fmt.Errorf("WSL 辅助程序未连接，请重新连接")
	default:
	}
	c.sequence++
	request.ID = c.sequence
	ch := make(chan Response, 1)
	c.pending[request.ID] = ch
	c.mu.Unlock()
	if deadline, ok := ctx.Deadline(); ok {
		request.Timeout = max(1, time.Until(deadline).Milliseconds())
	}
	c.writeMu.Lock()
	err := json.NewEncoder(c.in).Encode(request)
	c.writeMu.Unlock()
	if err != nil {
		c.fail()
		return err
	}
	defer func() { c.mu.Lock(); delete(c.pending, request.ID); c.mu.Unlock() }()
	select {
	case response := <-ch:
		if err := response.err(); err != nil {
			return err
		}
		if result != nil {
			return json.Unmarshal(response.Data, result)
		}
		return nil
	case <-ctx.Done():
		c.writeMu.Lock()
		_ = json.NewEncoder(c.in).Encode(Request{Op: "cancel", CancelID: request.ID})
		c.writeMu.Unlock()
		return ctx.Err()
	}
}
