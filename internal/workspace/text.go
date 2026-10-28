package workspace

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

const TextPreviewLimit = 512 << 10

type TextFile struct {
	Path string `json:"path"`
	Text string `json:"text"`
}

// ReadWorkspaceText resolves paths in the execution environment, including WSL.
// Both relative traversal and symlinks must remain inside a saved session root.
func ReadWorkspaceText(ctx context.Context, path string, roots []string) (TextFile, error) {
	if c := RemoteClient(ctx); c != nil {
		var result TextFile
		err := c.Call(ctx, Request{Op: "read-workspace-text", Path: path, Args: roots}, &result)
		return result, err
	}
	if len(roots) == 0 || path == "" || len(path) > 4096 || strings.ContainsRune(path, 0) {
		return TextFile{}, fmt.Errorf("文件路径无效")
	}
	if !filepath.IsAbs(path) {
		path = filepath.Join(roots[0], path)
	}
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return TextFile{}, fmt.Errorf("文件不存在、已移动或不可读取")
	}
	allowed := false
	for _, root := range roots {
		base, err := filepath.EvalSymlinks(root)
		if err != nil || !filepath.IsAbs(base) {
			continue
		}
		rel, err := filepath.Rel(base, resolved)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel) {
			allowed = true
			break
		}
	}
	if !allowed {
		return TextFile{}, fmt.Errorf("只能预览此会话工作目录及附加目录中的文件")
	}
	info, err := os.Stat(resolved)
	if err != nil || !info.Mode().IsRegular() {
		return TextFile{}, fmt.Errorf("仅支持预览普通文本文件")
	}
	if info.Size() > TextPreviewLimit {
		return TextFile{}, fmt.Errorf("文件超过 512 KiB，无法预览")
	}
	f, err := os.Open(resolved)
	if err != nil {
		return TextFile{}, fmt.Errorf("文件不可读取")
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return TextFile{}, fmt.Errorf("文件不可读取")
	}
	raw, err := io.ReadAll(io.LimitReader(f, TextPreviewLimit+1))
	if err != nil {
		return TextFile{}, err
	}
	if len(raw) > TextPreviewLimit {
		return TextFile{}, fmt.Errorf("文件超过 512 KiB，无法预览")
	}
	if !utf8.Valid(raw) || strings.ContainsRune(string(raw), 0) {
		return TextFile{}, fmt.Errorf("此文件不是 UTF-8 文本，无法预览")
	}
	return TextFile{Path: resolved, Text: strings.TrimPrefix(string(raw), "\ufeff")}, nil
}
