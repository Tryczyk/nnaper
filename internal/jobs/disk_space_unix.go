//go:build !windows

package jobs

import "syscall"

// GetFreeDiskSpace zwraca liczbę dostępnych bajtów wolnego miejsca na systemie plików zawierającym podaną ścieżkę.
func GetFreeDiskSpace(path string) (uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	return stat.Bavail * uint64(stat.Bsize), nil
}
