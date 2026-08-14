from abc import ABC, abstractmethod
from dataclasses import dataclass, asdict
from io import BytesIO
from typing import Awaitable, Callable, Optional


@dataclass
class FileItem:
    name: str
    type: str
    size: int
    date: str

    def to_dict(self) -> dict:
        return asdict(self)


class BackendError(Exception):
    pass


ProgressCB = Callable[[int, int, str], Awaitable[None]]


class FileBackend(ABC):
    @abstractmethod
    async def connect(self, params: dict) -> str:
        pass

    @abstractmethod
    async def disconnect(self) -> None:
        pass

    @abstractmethod
    async def getcwd(self) -> str:
        pass

    @abstractmethod
    async def list_dir(self, path: str) -> list[FileItem]:
        pass

    @abstractmethod
    async def mkdir(self, path: str) -> None:
        pass

    @abstractmethod
    async def delete(self, path: str) -> None:
        pass

    @abstractmethod
    async def delete_dir(self, path: str) -> None:
        pass

    async def rmdir(self, path: str, progress_cb: Optional[ProgressCB] = None) -> None:
        items = await self.list_dir(path)
        for i, item in enumerate(items):
            p = path.rstrip("/") + "/" + item.name
            if item.type == "dir":
                await self.rmdir(p, progress_cb)
                await self.delete_dir(p)
            else:
                await self.delete(p)
            if progress_cb:
                await progress_cb(i + 1, len(items), item.name)
        await self.delete_dir(path)

    async def noop(self) -> None:
        pass

    async def cancel(self) -> None:
        """Abort any in-progress transfer. Override for protocol-specific abort."""
        pass

    @abstractmethod
    async def rename(self, src: str, dst: str) -> None:
        pass

    async def _count_bytes(self, path: str) -> int:
        total = 0
        items = await self.list_dir(path)
        for item in items:
            if item.type == "dir":
                total += await self._count_bytes(path.rstrip("/") + "/" + item.name)
            else:
                total += item.size or 0
        return total

    async def copy(self, src: str, dst: str, progress_cb: Optional[ProgressCB] = None) -> None:
        parent = src.rsplit("/", 1)[0] if "/" in src else "/"
        items = await self.list_dir(parent)
        name = src.rsplit("/", 1)[-1]
        src_item = next((i for i in items if i.name == name), None)
        if src_item and src_item.type == "dir":
            try:
                await self.mkdir(dst)
            except BackendError:
                pass
            total = 2 * await self._count_bytes(src) if progress_cb else 0
            bytes_done = [0]
            if progress_cb:
                await progress_cb(0, total, '')
            await self._copy_dir(src, dst, total, bytes_done, progress_cb)
        else:
            size = src_item.size if src_item else 0
            if progress_cb and size:
                size = max(size, 1)

                async def _rc(cur, total, name):
                    await progress_cb(cur, 2 * size, name)

                async def _wc(cur, total, name):
                    await progress_cb(size + cur, 2 * size, name)

                await progress_cb(0, 2 * size, name)
                buf = await self.read_bytes(src, _rc, size)
                buf.seek(0)
                await self.write_bytes(dst, buf, _wc, size)
            else:
                buf = await self.read_bytes(src)
                await self.write_bytes(dst, buf)
    async def _copy_dir(self, src: str, dst: str, total: int, bytes_done: list[int], progress_cb: Optional[ProgressCB]) -> None:
        entries = await self.list_dir(src)
        for entry in entries:
            s = src.rstrip("/") + "/" + entry.name
            d = dst.rstrip("/") + "/" + entry.name
            name = entry.name
            if entry.type == "dir":
                try:
                    await self.mkdir(d)
                except BackendError:
                    pass
                await self._copy_dir(s, d, total, bytes_done, progress_cb)
            else:
                fs = entry.size or 0
                if progress_cb and fs:
                    base = bytes_done[0]

                    async def rc(cur, _t, _n, b=base, fn=name):
                        await progress_cb(b + cur, total, fn)

                    async def wc(cur, _t, _n, b=base, fn=name, fsize=fs):
                        await progress_cb(b + fsize + cur, total, fn)

                    await progress_cb(base, total, name)
                    buf = await self.read_bytes(s, rc, fs)
                    buf.seek(0)
                    await self.write_bytes(d, buf, wc, fs)
                else:
                    buf = await self.read_bytes(s)
                    await self.write_bytes(d, buf)
                bytes_done[0] += 2 * max(fs, 1)
            if progress_cb:
                await progress_cb(bytes_done[0], total, name)

    @abstractmethod
    async def read_bytes(self, path: str, progress_cb: Optional[ProgressCB] = None, total_size: int = 0) -> BytesIO:
        pass

    async def stream_bytes(self, path: str, chunk_size: int = 65536):
        """Stream file contents as chunks. Default: chunk read_bytes. Override for constant-memory streaming."""
        buf = await self.read_bytes(path)
        buf.seek(0)
        while True:
            chunk = buf.read(chunk_size)
            if not chunk:
                break
            yield chunk

    @abstractmethod
    async def write_bytes(self, path: str, buf: BytesIO, progress_cb: Optional[ProgressCB] = None, total_size: int = 0) -> None:
        pass

    @abstractmethod
    async def exists(self, path: str) -> bool:
        pass

    async def collect_paths(self, paths: list[str]) -> list[tuple[str, str]]:
        collected: list[tuple[str, str]] = []
        for path in paths:
            parent = path.rsplit("/", 1)[0] if "/" in path else "/"
            name = path.rsplit("/", 1)[-1]
            items = await self.list_dir(parent)
            item = next((i for i in items if i.name == name), None)
            if item and item.type == "dir":
                await self._collect_dir(path, name, collected)
            else:
                collected.append((path, name))
        return collected

    async def _collect_dir(self, dir_path: str, arc_prefix: str, collected: list[tuple[str, str]]):
        items = await self.list_dir(dir_path)
        for item in items:
            item_path = dir_path.rstrip("/") + "/" + item.name
            arc_name = arc_prefix + "/" + item.name
            if item.type == "dir":
                await self._collect_dir(item_path, arc_name, collected)
            else:
                collected.append((item_path, arc_name))
