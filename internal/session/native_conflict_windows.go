package session

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func nativeTerminalConflict(id, cwd string) error {
	if id == "" {
		return nil
	}
	// Ownership is checked while turns stream. A slow or failed PowerShell/WMI
	// query used to interrupt healthy turns, so read the process table directly.
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return fmt.Errorf("无法核实 Codex 终端占用：%w", err)
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		if !strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), "codex.exe") {
			continue
		}
		line, err := windowsProcessCommandLine(entry.ProcessID)
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) || errors.Is(err, windows.STATUS_PROCESS_IS_TERMINATING) {
			continue // The process exited after the snapshot was taken.
		}
		if err != nil {
			return fmt.Errorf("无法读取 Codex 进程 %d 的终端参数：%w", entry.ProcessID, err)
		}
		if err := windowsTerminalCommandConflict(id, line); err != nil {
			return err
		}
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return fmt.Errorf("无法核实 Codex 终端占用：%w", err)
	}
	return nil
}

func windowsProcessCommandLine(pid uint32) (string, error) {
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(process)
	// The query returns a local UNICODE_STRING followed by UTF-16 data. Its
	// USHORT length fits here with the header and terminator; no PEB/remote
	// memory access or shell encoding is involved.
	buffer := make([]byte, 1<<17)
	err = windows.NtQueryInformationProcess(process, windows.ProcessCommandLineInformation, unsafe.Pointer(&buffer[0]), uint32(len(buffer)), nil)
	if err != nil {
		var exitCode uint32
		if windows.GetExitCodeProcess(process, &exitCode) == nil && exitCode != 259 { // STILL_ACTIVE
			return "", windows.STATUS_PROCESS_IS_TERMINATING
		}
		return "", err
	}
	info := (*windows.NTUnicodeString)(unsafe.Pointer(&buffer[0]))
	if info.Length == 0 {
		return "", nil
	}
	base, start := uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(info.Buffer))
	if info.Length%2 != 0 || start < base+unsafe.Sizeof(*info) || start > base+uintptr(len(buffer)) || uintptr(info.Length) > base+uintptr(len(buffer))-start {
		return "", fmt.Errorf("Windows 返回了无效的终端参数")
	}
	line := info.String()
	runtime.KeepAlive(buffer)
	return line, nil
}

func windowsTerminalCommandConflict(id, line string) error {
	if id == "" || strings.TrimSpace(line) == "" {
		return nil
	}
	args, err := windows.DecomposeCommandLine(line)
	if err != nil {
		return fmt.Errorf("无法读取 Codex 终端参数：%w", err)
	}
	if len(args) > 1 && isCodexServerCommand(args[1]) {
		return nil
	}
	for _, arg := range args[1:] {
		if arg == id {
			return fmt.Errorf("此会话仍有 Codex 终端打开，请先退出终端中的 Codex")
		}
	}
	return nil
}
