import asyncio
import socket
from io import BytesIO
from ftplib import FTP, error_perm

from typing import Optional
from .base import FileBackend, FileItem, BackendError, ProgressCB


def _parse_line(line: str):
    line = line.strip()
    if not line:
        return None
    if "type=" in line:
        parts = line.split(";")
        ftype, size, modify = "file", 0, ""
        for p in parts:
            if p.startswith("type="):
                ftype = "dir" if p.split("=", 1)[1] == "dir" else "file"
            elif p.startswith("size="):
                try:
                    size = int(p.split("=", 1)[1])
                except ValueError:
                    pass
            elif p.startswith("modify="):
                modify = p.split("=", 1)[1]
        if "; " in line:
            name = line.split("; ", 1)[1].strip()
        else:
            non_facts = [s for s in parts if "=" not in s]
            name = non_facts[-1].strip() if non_facts else ""
        if not name:
            return None
        return {"name": name, "type": ftype, "size": size, "date": modify}
    toks = line.split()
    if len(toks) >= 9:
        return {
            "name": " ".join(toks[8:]),
            "type": "dir" if toks[0].startswith("d") else "file",
            "size": int(toks[4]),
            "date": f"{toks[5]} {toks[6]} {toks[7]}",
        }
    if len(toks) >= 4:
        dt = f"{toks[0]} {toks[1]}"
        if toks[2] == "<DIR>":
            return {"name": " ".join(toks[3:]), "type": "dir", "size": 0, "date": dt}
        try:
            return {
                "name": " ".join(toks[3:]),
                "type": "file",
                "size": int(toks[2]),
                "date": dt,
            }
        except ValueError:
            pass
    return None


def _list_dir_ftp(ftp: FTP, path: str) -> list[dict]:
    lines: list[str] = []
    tried_mlsd = False
    try:
        ftp.retrlines(f"MLSD {path}", lines.append)
        tried_mlsd = True
    except error_perm:
        pass
    if tried_mlsd:
        items = []
        for l in lines:
            p = _parse_line(l)
            if p and p["name"] not in (".", ".."):
                items.append(p)
        if items:
            return items
    lines.clear()
    items = []
    try:
        ftp.retrlines(f"LIST {path}", lines.append)
        for l in lines:
            p = _parse_line(l)
            if p and p["name"] not in (".", ".."):
                items.append(p)
    except error_perm:
        pass
    return items


class FTPBackend(FileBackend):
    def __init__(self):
        self._ftp: FTP | None = None
        self._cancelled = False

    async def noop(self) -> None:
        ftp = self._ftp
        if ftp and not self._cancelled:
            try:
                await asyncio.to_thread(ftp.voidcmd, "NOOP")
            except Exception:
                pass

    async def cancel(self) -> None:
        self._cancelled = True
        ftp = self._ftp
        if not ftp:
            return
        self._ftp = None
        for s in (ftp.sockobj, ftp.sock):
            if s:
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except Exception:
                    pass
                try:
                    s.close()
                except Exception:
                    pass
        await asyncio.to_thread(ftp.close)

    async def connect(self, params: dict) -> str:
        self._cancelled = False
        ftp = FTP()
        try:
            await asyncio.to_thread(
                ftp.connect, params["host"], int(params.get("port", 21)), timeout=10
            )
            await asyncio.to_thread(ftp.login, params["user"], params["pass"])
            ftp.set_pasv(params.get("passive", True))
            await asyncio.to_thread(ftp.sendcmd, "TYPE I")
        except Exception as e:
            raise BackendError(str(e)) from e
        self._ftp = ftp
        return await self.getcwd()

    async def disconnect(self) -> None:
        ftp = self._ftp
        if not ftp:
            return
        self._ftp = None
        for s in (ftp.sockobj, ftp.sock):
            if s:
                try:
                    s.shutdown(socket.SHUT_RDWR)
                except Exception:
                    pass
                try:
                    s.close()
                except Exception:
                    pass
        await asyncio.to_thread(ftp.close)

    async def getcwd(self) -> str:
        return await asyncio.to_thread(self._ftp.pwd)

    async def list_dir(self, path: str) -> list[FileItem]:
        raw = await asyncio.to_thread(_list_dir_ftp, self._ftp, path)
        return [FileItem(name=r["name"], type=r["type"], size=r["size"], date=r["date"]) for r in raw]

    async def mkdir(self, path: str) -> None:
        try:
            await asyncio.to_thread(self._ftp.mkd, path)
        except error_perm as e:
            raise BackendError(str(e)) from e

    async def delete(self, path: str) -> None:
        try:
            await asyncio.to_thread(self._ftp.delete, path)
        except error_perm as e:
            raise BackendError(str(e)) from e

    async def delete_dir(self, path: str) -> None:
        try:
            await asyncio.to_thread(self._ftp.rmd, path)
        except error_perm as e:
            raise BackendError(str(e)) from e

    async def rename(self, src: str, dst: str) -> None:
        try:
            await asyncio.to_thread(self._ftp.rename, src, dst)
        except error_perm as e:
            parent = src.rsplit("/", 1)[0] if "/" in src else "/"
            name = src.rsplit("/", 1)[-1]
            items = await self.list_dir(parent)
            src_item = next((i for i in items if i.name == name), None)
            if src_item and src_item.type == "dir":
                try:
                    await self.mkdir(dst)
                except BackendError:
                    pass
                await self.copy(src, dst)
                await self.rmdir(src)
            else:
                raise BackendError(str(e)) from e

    async def read_bytes(self, path: str, progress_cb: Optional[ProgressCB] = None, total_size: int = 0) -> BytesIO:
        buf = BytesIO()
        try:
            if progress_cb:
                total = total_size
                if not total:
                    try:
                        total = await asyncio.to_thread(lambda: self._ftp.size(path))
                    except Exception:
                        pass
                if total:
                    loop = asyncio.get_running_loop()
                    name = path.rsplit("/", 1)[-1]
                    br = [0]
                    lr = [0]

                    def _cb(data):
                        buf.write(data)
                        br[0] += len(data)
                        if br[0] - lr[0] >= 2097152 or br[0] == total:
                            lr[0] = br[0]
                            asyncio.run_coroutine_threadsafe(progress_cb(br[0], total, name), loop)

                    await asyncio.to_thread(lambda: self._ftp.retrbinary(f"RETR {path}", _cb))
                else:
                    await asyncio.to_thread(lambda: self._ftp.retrbinary(f"RETR {path}", buf.write))
            else:
                await asyncio.to_thread(lambda: self._ftp.retrbinary(f"RETR {path}", buf.write))
        except error_perm as e:
            raise BackendError(str(e)) from e
        buf.seek(0)
        return buf

    async def size(self, path: str) -> int:
        try:
            return await asyncio.to_thread(self._ftp.size, path)
        except Exception:
            raise BackendError(f"size failed: {path}")

    async def stream_bytes(self, path: str, chunk_size: int = 65536):
        conn = None
        try:
            conn = await asyncio.to_thread(self._ftp.transfercmd, f"RETR {path}")
            while True:
                chunk = await asyncio.to_thread(conn.recv, chunk_size)
                if not chunk:
                    break
                yield chunk
        except error_perm as e:
            raise BackendError(str(e)) from e
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
                try:
                    await asyncio.to_thread(self._ftp.voidresp)
                except Exception:
                    pass

    async def write_bytes(self, path: str, buf: BytesIO, progress_cb: Optional[ProgressCB] = None, total_size: int = 0) -> None:
        buf.seek(0)
        try:
            if progress_cb:
                total = total_size
                if not total:
                    buf.seek(0, 2)
                    total = buf.tell()
                    buf.seek(0)
                if total:
                    loop = asyncio.get_running_loop()
                    name = path.rsplit("/", 1)[-1]
                    bw = [0]
                    lr = [0]

                    def _cb(data):
                        bw[0] += len(data)
                        if bw[0] - lr[0] >= 2097152 or bw[0] == total:
                            lr[0] = bw[0]
                            asyncio.run_coroutine_threadsafe(progress_cb(bw[0], total, name), loop)

                    await asyncio.to_thread(lambda: self._ftp.storbinary(f"STOR {path}", buf, callback=_cb))
                else:
                    await asyncio.to_thread(lambda: self._ftp.storbinary(f"STOR {path}", buf))
            else:
                await asyncio.to_thread(lambda: self._ftp.storbinary(f"STOR {path}", buf))
        except error_perm as e:
            raise BackendError(str(e)) from e

    async def exists(self, path: str) -> bool:
        try:
            await asyncio.to_thread(self._ftp.size, path)
            return True
        except error_perm:
            pass
        name = path.rsplit("/", 1)[-1] if "/" in path else path
        parent = path.rsplit("/", 1)[0] if "/" in path else "/"
        try:
            items = await self.list_dir(parent)
            return any(i.name == name for i in items)
        except Exception:
            return False
