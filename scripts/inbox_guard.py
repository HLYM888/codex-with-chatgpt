"""Hold Windows directory handles that prevent rename/reparse replacement.

The helper deliberately has a tiny protocol: it acquires every directory
handle first, prints one ``ready`` JSON line, and then keeps the handles alive
until stdin reaches EOF.  It never creates files; missing directory components
are created one at a time while their parent handle is held.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
import sys
from typing import Any


ERROR_FILE_NOT_FOUND = 2
ERROR_PATH_NOT_FOUND = 3
ERROR_ACCESS_DENIED = 5
ERROR_SHARING_VIOLATION = 32
ERROR_ALREADY_EXISTS = 183

FILE_ATTRIBUTE_DIRECTORY = 0x00000010
FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
FILE_ATTRIBUTE_TAG_INFO_CLASS = 9
FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
FILE_READ_ATTRIBUTES = 0x00000080
DELETE = 0x00010000
FILE_SHARE_READ = 0x00000001
OPEN_EXISTING = 3


class GuardFailure(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class FileAttributeTagInfo(ctypes.Structure):
    _fields_ = [
        ("file_attributes", ctypes.c_uint32),
        ("reparse_tag", ctypes.c_uint32),
    ]


_CreateDirectoryW: Any = None
_CreateFileW: Any = None
_GetFileInformationByHandleEx: Any = None
_CloseHandle: Any = None
_INVALID_HANDLE_VALUE: Any = None


def _emit(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def _configure_windows_api() -> None:
    global _CreateDirectoryW, _CreateFileW, _GetFileInformationByHandleEx, _CloseHandle, _INVALID_HANDLE_VALUE
    if os.name != "nt":
        raise GuardFailure("INBOX_PLATFORM_UNSUPPORTED", "收件箱目录保护仅支持 Windows。")

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _CreateDirectoryW = kernel32.CreateDirectoryW
    _CreateDirectoryW.argtypes = [ctypes.c_wchar_p, ctypes.c_void_p]
    _CreateDirectoryW.restype = ctypes.c_int

    _CreateFileW = kernel32.CreateFileW
    _CreateFileW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
    ]
    _CreateFileW.restype = ctypes.c_void_p

    _GetFileInformationByHandleEx = kernel32.GetFileInformationByHandleEx
    _GetFileInformationByHandleEx.argtypes = [
        ctypes.c_void_p,
        ctypes.c_int,
        ctypes.c_void_p,
        ctypes.c_uint32,
    ]
    _GetFileInformationByHandleEx.restype = ctypes.c_int

    _CloseHandle = kernel32.CloseHandle
    _CloseHandle.argtypes = [ctypes.c_void_p]
    _CloseHandle.restype = ctypes.c_int

    _INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


def _normal_absolute(value: str, label: str) -> str:
    if not isinstance(value, str) or not value or "\x00" in value or not os.path.isabs(value):
        raise GuardFailure("INBOX_GUARD_INVALID", f"{label} 必须是有效绝对路径。")
    return os.path.normpath(os.path.abspath(value))


def _path_parts_under(parent: str, target: str, label: str) -> tuple[str, ...]:
    try:
        common = os.path.commonpath([parent, target])
    except ValueError as error:
        raise GuardFailure("INBOX_GUARD_INVALID", f"{label} 不在工作区授权目录内。") from error
    if os.path.normcase(os.path.normpath(common)) != os.path.normcase(parent):
        raise GuardFailure("INBOX_GUARD_INVALID", f"{label} 不在工作区授权目录内。")
    relative = os.path.relpath(target, parent)
    if relative in ("", "."):
        raise GuardFailure("INBOX_GUARD_INVALID", f"{label} 必须是授权目录的子目录。")
    parts = tuple(part for part in relative.split(os.sep) if part not in ("", "."))
    if not parts or any(part == ".." for part in parts):
        raise GuardFailure("INBOX_GUARD_INVALID", f"{label} 路径不安全。")
    return parts


def _win_failure(operation: str, winerror: int) -> GuardFailure:
    if winerror in (ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND):
        return GuardFailure("INBOX_PATH_NOT_FOUND", f"{operation} 目标目录不存在。")
    if winerror == ERROR_ACCESS_DENIED:
        return GuardFailure("INBOX_ACCESS_DENIED", f"{operation} 被 Windows 拒绝。")
    if winerror == ERROR_SHARING_VIOLATION:
        return GuardFailure("INBOX_LOCK_FAILED", f"{operation} 与现有目录锁冲突。")
    return GuardFailure("INBOX_GUARD_FAILED", f"{operation} 失败。")


def _open_directory(directory: str) -> Any:
    handle = _CreateFileW(
        directory,
        FILE_READ_ATTRIBUTES | DELETE,
        FILE_SHARE_READ,
        None,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
        None,
    )
    handle_value = getattr(handle, "value", handle)
    if handle_value in (None, _INVALID_HANDLE_VALUE):
        raise _win_failure("打开目录", ctypes.get_last_error())

    try:
        info = FileAttributeTagInfo()
        if not _GetFileInformationByHandleEx(
            handle,
            FILE_ATTRIBUTE_TAG_INFO_CLASS,
            ctypes.byref(info),
            ctypes.sizeof(info),
        ):
            raise _win_failure("读取目录属性", ctypes.get_last_error())
        if not info.file_attributes & FILE_ATTRIBUTE_DIRECTORY:
            raise GuardFailure("INBOX_NOT_DIRECTORY", "收件箱路径组件不是目录。")
        if info.file_attributes & FILE_ATTRIBUTE_REPARSE_POINT:
            raise GuardFailure("INBOX_REPARSE_POINT", "收件箱路径拒绝使用 junction 或其他 reparse point。")
        return handle
    except Exception:
        _CloseHandle(handle)
        raise


def _create_directory(directory: str) -> None:
    if _CreateDirectoryW(directory, None):
        return
    winerror = ctypes.get_last_error()
    if winerror == ERROR_ALREADY_EXISTS:
        return
    raise _win_failure("创建目录", winerror)


def _open_or_create(directory: str) -> Any:
    try:
        return _open_directory(directory)
    except GuardFailure as error:
        if error.code != "INBOX_PATH_NOT_FOUND":
            raise
    _create_directory(directory)
    return _open_directory(directory)


def _acquire(workspace: str, inbox: str, delivery: str | None) -> list[Any]:
    workspace = _normal_absolute(workspace, "workspaceRoot")
    inbox = _normal_absolute(inbox, "inboxAbsolute")
    delivery = _normal_absolute(delivery, "deliveryDir") if delivery is not None else None

    inbox_parts = _path_parts_under(workspace, inbox, "inboxAbsolute")
    delivery_parts = _path_parts_under(inbox, delivery, "deliveryDir") if delivery is not None else ()

    handles: list[Any] = []
    try:
        # The workspace is the first locked parent. Every subsequent mkdir/open
        # occurs while its immediate parent handle is held without FILE_SHARE_DELETE.
        handles.append(_open_directory(workspace))
        current = workspace
        for part in inbox_parts:
            current = os.path.join(current, part)
            handles.append(_open_or_create(current))

        current = inbox
        for part in delivery_parts:
            current = os.path.join(current, part)
            handles.append(_open_or_create(current))
        return handles
    except Exception:
        _release(handles)
        raise


def _release(handles: list[Any]) -> None:
    for handle in reversed(handles):
        try:
            _CloseHandle(handle)
        except Exception:
            pass


def _arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--workspace-root", required=True)
    parser.add_argument("--inbox", required=True)
    parser.add_argument("--delivery-dir")
    return parser.parse_args()


def main() -> int:
    if os.name != "nt":
        _emit({"ok": False, "error": {"code": "INBOX_PLATFORM_UNSUPPORTED", "message": "收件箱目录保护仅支持 Windows。"}})
        return 2

    handles: list[Any] = []
    try:
        _configure_windows_api()
        args = _arguments()
        handles = _acquire(args.workspace_root, args.inbox, args.delivery_dir)
        _emit({"ok": True, "state": "ready"})
        sys.stdin.buffer.read()
        return 0
    except GuardFailure as error:
        _emit({"ok": False, "error": {"code": error.code, "message": error.message}})
        return 2
    except (BrokenPipeError, EOFError):
        return 3
    except Exception:
        _emit({"ok": False, "error": {"code": "INBOX_GUARD_FAILED", "message": "收件箱目录保护进程失败。"}})
        return 3
    finally:
        _release(handles)


if __name__ == "__main__":
    raise SystemExit(main())
