package main

import (
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
)

func lockDataDirectory(dir string) (func(), error) {
	f, err := os.OpenFile(filepath.Join(dir, "instance.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	overlap := &windows.Overlapped{}
	if err := windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, overlap); err != nil {
		f.Close()
		return nil, err
	}
	return func() { f.Close() }, nil
}
