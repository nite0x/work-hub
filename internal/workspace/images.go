package workspace

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
)

const ImageLimit = 10 << 20

func ReadImage(ctx context.Context, path string) ([]byte, error) {
	if c := RemoteClient(ctx); c != nil {
		var raw []byte
		err := c.Call(ctx, Request{Op: "read-image", Path: path}, &raw)
		return raw, err
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("图片必须使用绝对路径")
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > ImageLimit {
		return nil, fmt.Errorf("图片不是普通文件或超过 10 MiB")
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err = f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, fmt.Errorf("图片不可读取")
	}
	raw, err := io.ReadAll(io.LimitReader(f, ImageLimit+1))
	if err != nil {
		return nil, err
	}
	if len(raw) > ImageLimit {
		return nil, fmt.Errorf("图片超过 10 MiB")
	}
	switch http.DetectContentType(raw) {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return raw, nil
	}
	return nil, fmt.Errorf("仅支持 PNG、JPEG、GIF 和 WebP 图片")
}
