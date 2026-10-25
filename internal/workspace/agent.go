package workspace

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"worktree-hub/internal/codex"
	"worktree-hub/internal/platform"
	"worktree-hub/internal/store"
)

type AgentHooks struct {
	WatchHistory     func(context.Context, string, func(json.RawMessage) error) error
	TerminalConflict func(string, string) error
}

// The helper only serves the private stdin/stdout channel opened by Windows.
// There is no listening network port and no shell command execution API.
func RunAgent(input io.Reader, output io.Writer, hooks AgentHooks) error {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var mu, writeMu sync.Mutex
	running := map[uint64]context.CancelFunc{}
	var wg sync.WaitGroup
	slots := make(chan struct{}, 8)
	respond := func(r Response) { writeMu.Lock(); _ = json.NewEncoder(output).Encode(r); writeMu.Unlock() }
	scan := bufio.NewScanner(input)
	scan.Buffer(make([]byte, 4096), 16<<20)
	for scan.Scan() {
		var request Request
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
			respond(Response{ID: request.ID, Error: "辅助程序繁忙，请稍后重试"})
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
		go func(request Request) {
			defer wg.Done()
			defer stop()
			defer func() { <-slots; mu.Lock(); delete(running, request.ID); mu.Unlock() }()
			var value any
			var err error
			if request.Op == "session-watch" {
				if hooks.WatchHistory == nil {
					respond(Response{ID: request.ID, Error: "不支持会话实时读取"})
					return
				}
				err = hooks.WatchHistory(requestCtx, request.Path, func(raw json.RawMessage) error {
					respond(Response{ID: request.ID, More: true, Data: raw})
					return requestCtx.Err()
				})
			} else if request.Op == "session-conflict" {
				if hooks.TerminalConflict == nil {
					err = fmt.Errorf("辅助程序不支持会话占用检查，请重新安装")
				} else {
					err = hooks.TerminalConflict(request.Method, request.Path)
				}
			} else {
				value, err = executeWorkspaceRequest(requestCtx, request)
			}
			response := Response{ID: request.ID}
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

func executeWorkspaceRequest(ctx context.Context, r Request) (any, error) {
	switch r.Op {
	case "rollout-activity":
		return codex.RolloutActivity(r.Path), nil
	case "read-image":
		return ReadImage(ctx, r.Path)
	case "export-metadata":
		return store.ExportMetadata(ctx, r.Path)
	case "validate-terminal":
		return CustomTerminalPath(r.Path)
	case "identity":
		home, err := os.UserHomeDir()
		return Identity{Protocol: Protocol, Home: home, User: os.Getenv("USER"), Distro: os.Getenv("WSL_DISTRO_NAME"), CredentialHelper: CredentialHelperCommand()}, err
	case "git":
		return RunGit(ctx, r.Path, 90*time.Second, r.Messages, r.Args...)
	case "normalize":
		return platform.NormalizePath(r.Path)
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
		return FileInfo{FileName: info.Name(), FileSize: info.Size(), FileMode: uint32(info.Mode()), Modified: info.ModTime()}, nil
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
		return Availability(r.Settings), nil
	case "terminal":
		if r.Plan == nil {
			return nil, fmt.Errorf("缺少终端参数")
		}
		p := *r.Plan
		if err := WriteTerminalScript(platform.DefaultDataDir(), &p); err != nil {
			return nil, err
		}
		a := &Service{DataDir: platform.DefaultDataDir()}
		return nil, a.StartTerminal(r.Settings, p, nil)
	case "session":
		switch r.Method {
		case "thread/list", "thread/read", "thread/items/list", "thread/turns/list":
		default:
			return nil, fmt.Errorf("辅助程序只支持读取会话")
		}
		c, err := codex.OpenSessionClient(ctx)
		if err != nil {
			return nil, err
		}
		defer c.Close()
		var result json.RawMessage
		err = c.Call(r.Method, r.Params, &result)
		return result, err
	default:
		return nil, fmt.Errorf("不支持的工作区操作：%s", r.Op)
	}
}
