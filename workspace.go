package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"
)

const workspaceProtocol = 1

type workspaceRequest struct {
	ID       uint64           `json:"id"`
	Op       string           `json:"op"`
	Path     string           `json:"path,omitempty"`
	Args     []string         `json:"args,omitempty"`
	Data     []byte           `json:"data,omitempty"`
	Flags    int              `json:"flags,omitempty"`
	Mode     uint32           `json:"mode,omitempty"`
	Timeout  int64            `json:"timeout_ms,omitempty"`
	Messages bool             `json:"messages,omitempty"`
	Method   string           `json:"method,omitempty"`
	Params   json.RawMessage  `json:"params,omitempty"`
	Plan     *LaunchPlan      `json:"plan,omitempty"`
	Settings TerminalSettings `json:"settings,omitempty"`
	CancelID uint64           `json:"cancel_id,omitempty"`
}
type workspaceResponse struct {
	More  bool            `json:"more,omitempty"`
	ID    uint64          `json:"id"`
	Data  json.RawMessage `json:"data,omitempty"`
	Error string          `json:"error,omitempty"`
	Code  string          `json:"code,omitempty"`
}
type workspaceIdentity struct {
	Protocol         int    `json:"protocol"`
	Home             string `json:"home"`
	User             string `json:"user"`
	Distro           string `json:"distro"`
	CredentialHelper string `json:"credential_helper"`
}
type workspaceClient struct {
	mu       sync.Mutex
	writeMu  sync.Mutex
	cmd      *exec.Cmd
	in       io.WriteCloser
	pending  map[uint64]chan workspaceResponse
	sequence uint64
	done     chan struct{}
	once     sync.Once
	identity workspaceIdentity
}
type workspaceContextKey struct{}

func withWorkspace(ctx context.Context, c *workspaceClient) context.Context {
	return context.WithValue(ctx, workspaceContextKey{}, c)
}
func remoteWorkspace(ctx context.Context) *workspaceClient {
	c, _ := ctx.Value(workspaceContextKey{}).(*workspaceClient)
	return c
}

func startWorkspaceClient(cmd *exec.Cmd) (*workspaceClient, error) {
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
	hideCommand(cmd)
	if err := cmd.Start(); err != nil {
		in.Close()
		return nil, err
	}
	c := &workspaceClient{cmd: cmd, in: in, pending: map[uint64]chan workspaceResponse{}, done: make(chan struct{})}
	go func() {
		scan := bufio.NewScanner(out)
		scan.Buffer(make([]byte, 4096), 16<<20)
		for scan.Scan() {
			var response workspaceResponse
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
	if err := c.call(ctx, workspaceRequest{Op: "identity"}, &c.identity); err != nil {
		c.close()
		return nil, err
	}
	if c.identity.Protocol != workspaceProtocol {
		c.close()
		return nil, fmt.Errorf("WSL 辅助程序协议不兼容，请重新安装辅助程序")
	}
	return c, nil
}
func (c *workspaceClient) fail() {
	c.once.Do(func() {
		close(c.done)
		c.mu.Lock()
		defer c.mu.Unlock()
		for id, ch := range c.pending {
			select {
			case <-ch:
			default:
			}
			ch <- workspaceResponse{Error: "WSL 辅助程序连接已断开，请重新连接后检查操作结果"}
			delete(c.pending, id)
		}
	})
}
func (c *workspaceClient) close() { _ = c.in.Close(); c.fail() }
func (c *workspaceClient) call(ctx context.Context, request workspaceRequest, result any) error {
	ctx, cancel := context.WithTimeout(ctx, 100*time.Second)
	defer cancel()
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
	ch := make(chan workspaceResponse, 1)
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
		if response.Error != "" {
			switch response.Code {
			case "not_exist":
				return fmt.Errorf("%s: %w", response.Error, os.ErrNotExist)
			case "exist":
				return fmt.Errorf("%s: %w", response.Error, os.ErrExist)
			}
			return errors.New(response.Error)
		}
		if result != nil {
			return json.Unmarshal(response.Data, result)
		}
		return nil
	case <-ctx.Done():
		c.writeMu.Lock()
		_ = json.NewEncoder(c.in).Encode(workspaceRequest{Op: "cancel", CancelID: request.ID})
		c.writeMu.Unlock()
		return ctx.Err()
	}
}

// The helper only serves the private stdin/stdout channel opened by Windows.
// There is no listening network port and no shell command execution API.
func runWorkspaceAgent(input io.Reader, output io.Writer) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu, writeMu sync.Mutex
	running := map[uint64]context.CancelFunc{}
	var wg sync.WaitGroup
	slots := make(chan struct{}, 8)
	respond := func(r workspaceResponse) { writeMu.Lock(); _ = json.NewEncoder(output).Encode(r); writeMu.Unlock() }
	scan := bufio.NewScanner(input)
	scan.Buffer(make([]byte, 4096), 16<<20)
	for scan.Scan() {
		var request workspaceRequest
		if err := json.Unmarshal(scan.Bytes(), &request); err != nil {
			cancel()
			wg.Wait()
			return err
		}
		if request.Op == "cancel" {
			mu.Lock()
			stop := running[request.CancelID]
			mu.Unlock()
			if stop != nil {
				stop()
			}
			continue
		}
		select {
		case slots <- struct{}{}:
		default:
			respond(workspaceResponse{ID: request.ID, Error: "辅助程序繁忙，请稍后重试"})
			continue
		}
		duration := time.Duration(request.Timeout) * time.Millisecond
		if duration <= 0 || duration > 100*time.Second {
			duration = 100 * time.Second
		}
		requestCtx, stop := context.WithTimeout(ctx, duration)
		if request.Op == "session-watch" {
			stop()
			requestCtx, stop = context.WithCancel(ctx)
		}
		mu.Lock()
		running[request.ID] = stop
		mu.Unlock()
		wg.Add(1)
		go func(request workspaceRequest) {
			defer wg.Done()
			defer stop()
			defer func() { <-slots; mu.Lock(); delete(running, request.ID); mu.Unlock() }()
			var value any
			var err error
			if request.Op == "session-watch" {
				err = watchCodexHistory(requestCtx, request.Path, func(state HistoryPush) error {
					raw, err := json.Marshal(state)
					if err != nil {
						return err
					}
					respond(workspaceResponse{ID: request.ID, More: true, Data: raw})
					return requestCtx.Err()
				})
			} else {
				value, err = executeWorkspaceRequest(requestCtx, request)
			}
			response := workspaceResponse{ID: request.ID}
			if err != nil {
				response.Error = err.Error()
				if errors.Is(err, os.ErrNotExist) {
					response.Code = "not_exist"
				}
				if errors.Is(err, os.ErrExist) {
					response.Code = "exist"
				}
			} else {
				response.Data, _ = json.Marshal(value)
			}
			respond(response)
		}(request)
	}
	cancel()
	wg.Wait()
	return scan.Err()
}

func executeWorkspaceRequest(ctx context.Context, r workspaceRequest) (any, error) {
	switch r.Op {
	case "export-metadata":
		return exportMetadata(ctx, r.Path)
	case "validate-terminal":
		return customTerminalPath(r.Path)
	case "identity":
		home, err := os.UserHomeDir()
		return workspaceIdentity{Protocol: workspaceProtocol, Home: home, User: os.Getenv("USER"), Distro: os.Getenv("WSL_DISTRO_NAME"), CredentialHelper: credentialHelperCommand()}, err
	case "git":
		return runGit(ctx, r.Path, 90*time.Second, r.Messages, r.Args...)
	case "normalize":
		return normalizePath(r.Path)
	case "eval":
		return filepath.EvalSymlinks(r.Path)
	case "stat", "lstat":
		var info os.FileInfo
		var err error
		if r.Op == "stat" {
			info, err = os.Stat(r.Path)
		} else {
			info, err = os.Lstat(r.Path)
		}
		if err != nil {
			return nil, err
		}
		return workspaceFileInfo{FileName: info.Name(), FileSize: info.Size(), FileMode: uint32(info.Mode()), Modified: info.ModTime()}, nil
	case "mkdir":
		return nil, os.Mkdir(r.Path, os.FileMode(r.Mode))
	case "mkdirall":
		return nil, os.MkdirAll(r.Path, os.FileMode(r.Mode))
	case "remove":
		return nil, os.Remove(r.Path)
	case "write":
		f, err := os.OpenFile(r.Path, r.Flags, os.FileMode(r.Mode))
		if err != nil {
			return nil, err
		}
		_, err = f.Write(r.Data)
		return nil, errors.Join(err, f.Close())
	case "terminal-availability":
		return terminalAvailability(r.Settings), nil
	case "terminal":
		if r.Plan == nil {
			return nil, fmt.Errorf("缺少终端参数")
		}
		p := *r.Plan
		if err := writeTerminalScript(defaultDataDir(), &p); err != nil {
			return nil, err
		}
		a := &App{dataDir: defaultDataDir()}
		return nil, a.startTerminal(r.Settings, p)
	case "session":
		switch r.Method {
		case "thread/list", "thread/read", "thread/items/list", "thread/turns/list":
		default:
			return nil, fmt.Errorf("辅助程序只支持读取会话")
		}
		c, err := openCodexClient(ctx)
		if err != nil {
			return nil, err
		}
		defer c.close()
		var result json.RawMessage
		err = c.call(r.Method, r.Params, &result)
		return result, err
	default:
		return nil, fmt.Errorf("不支持的工作区操作：%s", r.Op)
	}
}

type workspaceFileInfo struct {
	FileName string    `json:"name"`
	FileSize int64     `json:"size"`
	FileMode uint32    `json:"mode"`
	Modified time.Time `json:"modified"`
}

func (f workspaceFileInfo) Name() string       { return f.FileName }
func (f workspaceFileInfo) Size() int64        { return f.FileSize }
func (f workspaceFileInfo) Mode() os.FileMode  { return os.FileMode(f.FileMode) }
func (f workspaceFileInfo) ModTime() time.Time { return f.Modified }
func (f workspaceFileInfo) IsDir() bool        { return f.Mode().IsDir() }
func (f workspaceFileInfo) Sys() any           { return nil }

func workspaceStat(ctx context.Context, p string, follow bool) (os.FileInfo, error) {
	if c := remoteWorkspace(ctx); c != nil {
		op := "lstat"
		if follow {
			op = "stat"
		}
		var info workspaceFileInfo
		err := c.call(ctx, workspaceRequest{Op: op, Path: p}, &info)
		return info, err
	}
	if follow {
		return os.Stat(p)
	}
	return os.Lstat(p)
}
func workspaceEval(ctx context.Context, p string) (string, error) {
	if c := remoteWorkspace(ctx); c != nil {
		var value string
		err := c.call(ctx, workspaceRequest{Op: "eval", Path: p}, &value)
		return value, err
	}
	return filepath.EvalSymlinks(p)
}
func workspaceNormalize(ctx context.Context, p string) (string, error) {
	if c := remoteWorkspace(ctx); c != nil {
		var value string
		err := c.call(ctx, workspaceRequest{Op: "normalize", Path: p}, &value)
		return value, err
	}
	return normalizePath(p)
}
func workspaceMkdir(ctx context.Context, p string, mode os.FileMode, all bool) error {
	if c := remoteWorkspace(ctx); c != nil {
		op := "mkdir"
		if all {
			op = "mkdirall"
		}
		return c.call(ctx, workspaceRequest{Op: op, Path: p, Mode: uint32(mode)}, nil)
	}
	if all {
		return os.MkdirAll(p, mode)
	}
	return os.Mkdir(p, mode)
}
func workspaceRemove(ctx context.Context, p string) error {
	if c := remoteWorkspace(ctx); c != nil {
		return c.call(ctx, workspaceRequest{Op: "remove", Path: p}, nil)
	}
	return os.Remove(p)
}
func workspaceWrite(ctx context.Context, p string, data []byte, flags int, mode os.FileMode) error {
	if c := remoteWorkspace(ctx); c != nil {
		return c.call(ctx, workspaceRequest{Op: "write", Path: p, Data: data, Flags: flags, Mode: uint32(mode)}, nil)
	}
	f, err := os.OpenFile(p, flags, mode)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	return errors.Join(err, f.Close())
}

type workspaceSessions struct {
	ctx    context.Context
	client *workspaceClient
}

func (c *workspaceSessions) call(method string, params any, result any) error {
	raw, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.client.call(c.ctx, workspaceRequest{Op: "session", Method: method, Params: raw}, result)
}
func (c *workspaceSessions) close() {}

func (c *workspaceClient) watchHistory(ctx context.Context, session string, emit func(HistoryPush) error) error {
	c.mu.Lock()
	select {
	case <-c.done:
		c.mu.Unlock()
		return fmt.Errorf("WSL 辅助程序未连接")
	default:
	}
	c.sequence++
	id := c.sequence
	ch := make(chan workspaceResponse, 1)
	c.pending[id] = ch
	c.mu.Unlock()
	c.writeMu.Lock()
	err := json.NewEncoder(c.in).Encode(workspaceRequest{ID: id, Op: "session-watch", Path: session})
	c.writeMu.Unlock()
	if err != nil {
		c.fail()
		return err
	}
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		c.writeMu.Lock()
		_ = json.NewEncoder(c.in).Encode(workspaceRequest{Op: "cancel", CancelID: id})
		c.writeMu.Unlock()
	}()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.done:
			return fmt.Errorf("WSL 实时连接已断开")
		case response := <-ch:
			if response.Error != "" {
				return errors.New(response.Error)
			}
			if !response.More {
				return nil
			}
			var state HistoryPush
			if err := json.Unmarshal(response.Data, &state); err != nil {
				return err
			}
			if err := emit(state); err != nil {
				return err
			}
		}
	}
}
