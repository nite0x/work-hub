package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"

	"worktree-hub/internal/platform"
)

type FileInfo struct {
	FileName string    `json:"name"`
	FileSize int64     `json:"size"`
	FileMode uint32    `json:"mode"`
	Modified time.Time `json:"modified"`
}

func (f FileInfo) Name() string       { return f.FileName }
func (f FileInfo) Size() int64        { return f.FileSize }
func (f FileInfo) Mode() os.FileMode  { return os.FileMode(f.FileMode) }
func (f FileInfo) ModTime() time.Time { return f.Modified }
func (f FileInfo) IsDir() bool        { return f.Mode().IsDir() }
func (f FileInfo) Sys() any           { return nil }

func Stat(ctx context.Context, p string, follow bool) (os.FileInfo, error) {
	if c := RemoteClient(ctx); c != nil {
		op := "lstat"
		if follow {
			op = "stat"
		}
		var info FileInfo
		err := c.Call(ctx, Request{Op: op, Path: p}, &info)
		return info, err
	}
	if follow {
		return os.Stat(p)
	}
	return os.Lstat(p)
}
func Eval(ctx context.Context, p string) (string, error) {
	if c := RemoteClient(ctx); c != nil {
		var value string
		err := c.Call(ctx, Request{Op: "eval", Path: p}, &value)
		return value, err
	}
	return filepath.EvalSymlinks(p)
}
func Normalize(ctx context.Context, p string) (string, error) {
	if c := RemoteClient(ctx); c != nil {
		var value string
		err := c.Call(ctx, Request{Op: "normalize", Path: p}, &value)
		return value, err
	}
	return platform.NormalizePath(p)
}
func Mkdir(ctx context.Context, p string, mode os.FileMode, all bool) error {
	if c := RemoteClient(ctx); c != nil {
		op := "mkdir"
		if all {
			op = "mkdirall"
		}
		return c.Call(ctx, Request{Op: op, Path: p, Mode: uint32(mode)}, nil)
	}
	if all {
		return os.MkdirAll(p, mode)
	}
	return os.Mkdir(p, mode)
}
func Remove(ctx context.Context, p string) error {
	if c := RemoteClient(ctx); c != nil {
		return c.Call(ctx, Request{Op: "remove", Path: p}, nil)
	}
	return os.Remove(p)
}
func Write(ctx context.Context, p string, data []byte, flags int, mode os.FileMode) error {
	if c := RemoteClient(ctx); c != nil {
		return c.Call(ctx, Request{Op: "write", Path: p, Data: data, Flags: flags, Mode: uint32(mode)}, nil)
	}
	f, err := os.OpenFile(p, flags, mode)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	return errors.Join(err, f.Close())
}
