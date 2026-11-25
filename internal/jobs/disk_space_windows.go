//go:build windows

package jobs

import (
	"syscall"
	"unsafe"
)

var (
	kernel32            = syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceExW = kernel32.NewProc("GetDiskFreeSpaceExW")
)

// GetFreeDiskSpace zwraca liczbę dostępnych bajtów wolnego miejsca na systemie plików zawierającym podaną ścieżkę.
func GetFreeDiskSpace(path string) (uint64, error) {
	var freeBytesAvailable, totalNumberOfBytes, totalNumberOfFreeBytes uint64

	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}

	r1, _, errNo := getDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(p)),
		uintptr(unsafe.Pointer(&freeBytesAvailable)),
		uintptr(unsafe.Pointer(&totalNumberOfBytes)),
		uintptr(unsafe.Pointer(&totalNumberOfFreeBytes)),
	)
	if r1 == 0 {
		return 0, errNo
	}
	return freeBytesAvailable, nil
}
