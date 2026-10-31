package workspace

import (
	"context"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const DirectoryPreviewLimit = 5000

type DirectoryEntry struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	Directory bool   `json:"directory"`
	Symlink   bool   `json:"symlink,omitempty"`
}
type DirectoryPreview struct {
	Entries   []DirectoryEntry `json:"entries"`
	Truncated bool             `json:"truncated"`
}

// BrowserPath accepts only paths inside a registered worktree, excluding Git's
// private metadata. Resolve again before reading so links cannot escape it.
func BrowserPath(root, relative string) (string, error) {
	if filepath.IsAbs(relative) || strings.ContainsAny(relative, "\\\x00") {
		return "", fmt.Errorf("文件路径无效")
	}
	for _, part := range strings.Split(relative, "/") {
		if part == ".." || strings.EqualFold(part, ".git") {
			return "", fmt.Errorf("文件路径无效")
		}
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", fmt.Errorf("工作目录不可用")
	}
	path, err := filepath.EvalSymlinks(filepath.Join(base, filepath.FromSlash(relative)))
	if err != nil {
		return "", fmt.Errorf("文件不存在、已移动或不可读取")
	}
	rel, err := filepath.Rel(base, path)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return "", fmt.Errorf("文件超出当前工作目录")
	}
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if strings.EqualFold(part, ".git") {
			return "", fmt.Errorf("不能预览 Git 内部文件")
		}
	}
	return path, nil
}

func BrowseWorkspace(ctx context.Context, root, relative string, file bool) (any, error) {
	if c := RemoteClient(ctx); c != nil {
		op := "browse-directory"
		if file {
			op = "browse-file"
			var result TextFile
			err := c.Call(ctx, Request{Op: op, Path: root, Args: []string{relative}}, &result)
			return result, err
		}
		var result DirectoryPreview
		err := c.Call(ctx, Request{Op: op, Path: root, Args: []string{relative}}, &result)
		return result, err
	}
	path, err := BrowserPath(root, relative)
	if err != nil {
		return nil, err
	}
	if file {
		return ReadWorkspaceText(ctx, path, []string{root})
	}
	dir, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("目录不可读取")
	}
	defer dir.Close()
	entries, err := dir.ReadDir(DirectoryPreviewLimit + 1)
	if err != nil && err != io.EOF {
		return nil, fmt.Errorf("目录不可读取")
	}
	result := DirectoryPreview{Entries: []DirectoryEntry{}, Truncated: len(entries) > DirectoryPreviewLimit}
	if result.Truncated {
		entries = entries[:DirectoryPreviewLimit]
	}
	for _, entry := range entries {
		if strings.EqualFold(entry.Name(), ".git") {
			continue
		}
		result.Entries = append(result.Entries, DirectoryEntry{Name: entry.Name(), Path: filepath.ToSlash(filepath.Join(relative, entry.Name())), Directory: entry.IsDir(), Symlink: entry.Type()&os.ModeSymlink != 0})
	}
	sort.Slice(result.Entries, func(i, j int) bool {
		a, b := result.Entries[i], result.Entries[j]
		if a.Directory != b.Directory {
			return a.Directory
		}
		return a.Name < b.Name
	})
	return result, nil
}
