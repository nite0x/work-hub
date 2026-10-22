package main

import (
	"fmt"
	"github.com/jchv/go-webview2"
	"golang.org/x/sys/windows"
	"net/url"
	"path/filepath"
	"runtime"
	"unsafe"
)

func showDesktop(address, dataDir string) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	u, err := url.Parse(address)
	if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" {
		return fmt.Errorf("桌面服务地址无效")
	}
	w := webview2.NewWithOptions(webview2.WebViewOptions{AutoFocus: true, DataPath: filepath.Join(dataDir, "webview"), WindowOptions: webview2.WindowOptions{Title: "Work Hub", IconId: 1, Width: 1380, Height: 900, Center: true}})
	if w == nil {
		return fmt.Errorf("无法启动桌面窗口，请安装 Microsoft Edge WebView2 Runtime；也可使用 --headless 后在浏览器打开本地地址")
	}
	defer w.Destroy()
	w.Navigate(address)
	w.Run()
	return nil
}

func showDesktopError(err error) {
	message, _ := windows.UTF16PtrFromString(err.Error())
	title, _ := windows.UTF16PtrFromString("Work Hub 启动失败")
	_, _, _ = windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(message)), uintptr(unsafe.Pointer(title)), 0x10)
}
