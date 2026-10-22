//go:build linux

package session

import (
	"context"
	"net"
	"os"
	"syscall"
)

func bridgePeerContext(ctx context.Context, c net.Conn) context.Context {
	u, ok := c.(*net.UnixConn)
	if !ok {
		return ctx
	}
	raw, err := u.SyscallConn()
	if err != nil {
		return ctx
	}
	var cred *syscall.Ucred
	_ = raw.Control(func(fd uintptr) { cred, _ = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED) })
	if cred != nil && int(cred.Uid) == os.Getuid() {
		return context.WithValue(ctx, bridgePeerKey{}, int(cred.Pid))
	}
	return ctx
}
