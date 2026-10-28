package workspace

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unicode"
)

const MaxAttachmentSize = 8 << 20

// StoreAttachment keeps original bytes outside repositories, on the machine
// running Codex. The content address also makes interrupted upload retries safe.
func StoreAttachment(ctx context.Context, dataDir, name string, data []byte) (string, error) {
	if len(data) > MaxAttachmentSize || name == "" || len(name) > 240 || strings.ContainsAny(name, "/\\") || strings.IndexFunc(name, unicode.IsControl) >= 0 || name == "." || name == ".." {
		return "", fmt.Errorf("文件名无效或文件超过 8 MiB")
	}
	if c := RemoteClient(ctx); c != nil {
		var path string
		err := c.Call(ctx, Request{Op: "store-attachment", Args: []string{name}, Data: data}, &path)
		return path, err
	}
	// Keep extensions and Unicode names, while allowing the same upload on Windows.
	safeName := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	safeName = strings.TrimRight(safeName, ". ")
	if safeName == "" {
		safeName = "attachment"
	}
	// Prefix the basename so Windows device names (CON, NUL, ...) stay ordinary files.
	dir := filepath.Join(dataDir, "attachments", fmt.Sprintf("%x", sha256.Sum256(data)))
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "file-"+safeName)
	if existing, err := os.ReadFile(path); err == nil && sha256.Sum256(existing) == sha256.Sum256(data) {
		return path, nil
	}
	f, err := os.CreateTemp(dir, ".upload-")
	if err != nil {
		return "", err
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr != nil {
		return "", writeErr
	}
	if closeErr != nil {
		return "", closeErr
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return "", err
	}
	return path, nil
}
