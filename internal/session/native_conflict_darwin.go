package session

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"golang.org/x/sys/unix"
)

func nativeTerminalConflict(id, cwd string) error {
	if id == "" {
		return nil
	}
	processes, err := unix.SysctlKinfoProcSlice("kern.proc.uid", os.Getuid())
	if err != nil {
		return fmt.Errorf("无法核实 Codex 终端占用：%w", err)
	}
	for _, process := range processes {
		if unix.ByteSliceToString(process.Proc.P_comm[:]) != "codex" {
			continue
		}
		pid := int(process.Proc.P_pid)
		raw, err := unix.SysctlRaw("kern.procargs2", pid)
		if errors.Is(err, unix.ESRCH) {
			continue
		}
		if err != nil {
			return fmt.Errorf("无法读取 Codex 终端参数：%w", err)
		}
		args, err := darwinProcessArgs(raw)
		if err != nil {
			return err
		}
		if len(args) > 1 && isCodexServerCommand(args[1]) {
			continue
		}
		for _, arg := range args[1:] {
			if arg == id {
				return fmt.Errorf("此会话仍有 Codex 终端打开，请先退出终端中的 Codex")
			}
		}
	}
	return nil
}

// KERN_PROCARGS2 is argc, the executable path, padding, then NUL-separated
// argv. Stop at argc so environment values never enter argument matching.
func darwinProcessArgs(raw []byte) ([]string, error) {
	invalid := fmt.Errorf("无法读取 Codex 终端参数")
	if len(raw) < 4 {
		return nil, invalid
	}
	count := int(binary.LittleEndian.Uint32(raw[:4]))
	data := raw[4:]
	end := bytes.IndexByte(data, 0)
	if count < 1 || count > len(data) || end < 0 {
		return nil, invalid
	}
	data = bytes.TrimLeft(data[end:], "\x00")
	args := make([]string, 0, count)
	for range count {
		end = bytes.IndexByte(data, 0)
		if end < 0 {
			return nil, invalid
		}
		args = append(args, string(data[:end]))
		data = data[end+1:]
	}
	return args, nil
}

func darwinProcessCwd(pid int) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// Fixed executable and separate arguments; paths never enter shell code.
	raw, err := exec.CommandContext(ctx, "/usr/sbin/lsof", "-a", "-p", strconv.Itoa(pid), "-d", "cwd", "-Fn0").Output()
	if err == nil {
		for _, field := range bytes.Split(raw, []byte{0}) {
			if len(field) > 1 && field[0] == 'n' && filepath.IsAbs(string(field[1:])) {
				return string(field[1:]), nil
			}
		}
	}
	return "", fmt.Errorf("无法核实 Codex 终端的工作目录")
}
