import uuid
import json
import asyncio
import os
import base64
import secrets
import zipfile
from io import BytesIO
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse, Response
from fastapi.staticfiles import StaticFiles
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from typing import Optional
from server.backends import BackendFactory, BackendError, FileBackend
from server.backends.base import ProgressCB

app = FastAPI()

app.mount("/assets", StaticFiles(directory=os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "assets")), name="assets")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sessions: dict[str, dict] = {}
download_tokens: dict[str, dict] = {}


def load_config():
    path = os.path.join(ROOT, "config", "config.yaml")
    if not os.path.isfile(path):
        return {}
    cfg = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if ":" not in line:
                continue
            key, _, val = line.partition(":")
            key = key.strip()
            val = val.strip().strip('"').strip("'")
            if val == "true":
                val = True
            elif val == "false":
                val = False
            elif val.isdigit() or (val.startswith("-") and val[1:].isdigit()):
                val = int(val)
            cfg[key] = val
    return cfg


_USE_HEADERS = load_config().get("use_headers", False)


def norm_path(path: str) -> str:
    if not path:
        return "/"
    path = path.replace("\\", "/")
    parts = [p for p in path.split("/") if p and p != "."]
    stack: list[str] = []
    for p in parts:
        if p == "..":
            if stack:
                stack.pop()
        else:
            stack.append(p)
    return "/" + "/".join(stack) if stack else "/"


_COOKIE_KEY: Optional[bytes] = None


def get_cookie_key() -> Optional[bytes]:
    global _COOKIE_KEY
    if _COOKIE_KEY is not None:
        return _COOKIE_KEY
    cfg = load_config()
    raw = cfg.get("cookieKey") or os.environ.get("FFM_COOKIE_KEY") or ""
    if raw:
        _COOKIE_KEY = bytes.fromhex(raw) if len(raw) == 64 else raw.encode("utf-8")
    return _COOKIE_KEY


def encrypt_auth(params: dict) -> Optional[str]:
    key = get_cookie_key()
    if key is None:
        return None
    nonce = secrets.token_bytes(12)
    ct = AESGCM(key).encrypt(nonce, json.dumps(params).encode("utf-8"), None)
    return "v1:" + base64.urlsafe_b64encode(nonce + ct).decode("ascii")


def decrypt_auth(token: str) -> Optional[dict]:
    if not token.startswith("v1:"):
        return None
    try:
        blob = base64.urlsafe_b64decode(token[3:].encode("ascii"))
        nonce, ct = blob[:12], blob[12:]
        data = AESGCM(get_cookie_key()).decrypt(nonce, ct, None)
        params = json.loads(data.decode("utf-8"))
        return params if isinstance(params, dict) else None
    except Exception:
        return None


async def handle_msg(ws: WebSocket, data: dict, sess: dict):
    action = data.get("action", "")
    params = data.get("params", {})

    if action == "ping":
        await ws.send_json({"type": "pong"})
        be = sess.get("backend")
        if be:
            lock = sess["lock"]
            async def _noop():
                async with lock:
                    try:
                        await be.noop()
                    except Exception:
                        pass
            asyncio.ensure_future(_noop())
        return

    if action == "cancel":
        sess["cancelled"] = True
        sess["gen"] += 1
        sess["upload_buf"] = None
        sess["upload_path"] = None

        be = sess.get("backend")
        if be:
            await be.cancel()
            sess["backend"] = None

        for key in ("write_task", "bg_task"):
            t = sess.get(key)
            if t and not t.done():
                t.cancel()
                try:
                    await t
                except (asyncio.CancelledError, Exception):
                    pass
                sess[key] = None

        sess["lock"] = asyncio.Lock()
        await ws.send_json({"type": "ok"})
        return

    be: Optional[FileBackend] = sess.get("backend")
    lock = sess["lock"]

    async with lock:
        if action == "auth":
            token = params.get("token") if isinstance(params, dict) else None
            cfg = load_config()
            backend_type = cfg.get("backend", "ftp")
            if token:
                auth_params = decrypt_auth(token)
                if not auth_params:
                    await ws.send_json({"type": "auth_error", "msg": "Session expired. Please log in again."})
                    return
                backend_type = auth_params.get("backend", backend_type)
                params = auth_params
            try:
                be = await BackendFactory.create(backend_type, params)
                sess["backend"] = be
                auth_params = {k: params[k] for k in ("host", "port", "user", "pass", "passive") if k in params}
                auth_params["backend"] = backend_type
                sess["auth_params"] = auth_params
                cwd = await be.getcwd()
                items = await be.list_dir(cwd)
                token = encrypt_auth(auth_params)
                msg = {"type": "auth_ok", "cwd": cwd, "items": [i.to_dict() for i in items]}
                if token:
                    msg["token"] = token
                await ws.send_json(msg)
            except (BackendError, Exception) as e:
                await ws.send_json({"type": "auth_error", "msg": str(e)})
            return

        if be is None:
            auth = sess.get("auth_params")
            if auth:
                try:
                    be = await BackendFactory.create(auth.get("backend", "ftp"), auth)
                    sess["backend"] = be
                except Exception:
                    pass
            if sess.get("backend") is None:
                await ws.send_json({"type": "error", "code": "not_authenticated", "msg": "Not authenticated"})
                return

        async def _op_progress(current: int, total: int, name: str) -> None:
            if sess.get("cancelled"):
                return
            try:
                await ws.send_json({
                    "type": "op_progress", "current": current, "total": total, "name": name
                })
            except Exception:
                pass

        try:
            if action == "list":
                path = norm_path(params.get("path", ""))
                items = await be.list_dir(path)
                await ws.send_json({"type": "list_ok", "path": path, "items": [i.to_dict() for i in items]})

            elif action == "list_items":
                path = norm_path(params.get("path", ""))
                items = await be.list_dir(path)
                await ws.send_json({"type": "list_items_ok", "path": path, "items": [i.to_dict() for i in items]})

            elif action == "mkdir":
                p = norm_path(params["path"])
                await be.mkdir(p)
                await ws.send_json({"type": "ok"})

            elif action == "rmdir":
                p = norm_path(params["path"])
                gen = sess["gen"]

                async def _do_rmdir():
                    try:
                        await be.rmdir(p, progress_cb=_op_progress)
                        if sess.get("gen") == gen and not sess.get("cancelled"):
                            await ws.send_json({"type": "ok"})
                    except Exception:
                        if sess.get("gen") == gen and not sess.get("cancelled"):
                            await ws.send_json({"type": "error", "msg": "rmdir failed"})
                    finally:
                        sess.pop("bg_task", None)

                sess["bg_task"] = asyncio.create_task(_do_rmdir())

            elif action == "delete":
                p = norm_path(params["path"])
                await be.delete(p)
                await ws.send_json({"type": "ok"})

            elif action == "move":
                src = norm_path(params["source"])
                dst_dir = norm_path(params["dest"])
                name = src.rsplit("/", 1)[-1]
                dst = dst_dir.rstrip("/") + "/" + name
                if not params.get("confirm_overwrite"):
                    if await be.exists(dst):
                        await ws.send_json({"type": "file_exists", "name": name, "context": "move", "source": src, "dest": dst_dir})
                        return
                gen = sess["gen"]

                async def _do_move():
                    try:
                        await be.rename(src, dst)
                        if sess.get("gen") == gen and not sess.get("cancelled"):
                            await ws.send_json({"type": "ok"})
                    except Exception:
                        if sess.get("gen") == gen and not sess.get("cancelled"):
                            await ws.send_json({"type": "error", "msg": "Move failed"})
                    finally:
                        sess.pop("bg_task", None)

                sess["bg_task"] = asyncio.create_task(_do_move())

            elif action == "rename":
                src = norm_path(params["source"])
                dst = norm_path(params["dest"])
                await be.rename(src, dst)
                await ws.send_json({"type": "ok"})

            elif action == "copy":
                src = norm_path(params["source"])
                dst_dir = norm_path(params["dest"])
                name = src.rsplit("/", 1)[-1]
                dst = dst_dir.rstrip("/") + "/" + name
                if not params.get("confirm_overwrite"):
                    if await be.exists(dst):
                        await ws.send_json({"type": "file_exists", "name": name, "context": "copy", "source": src, "dest": dst_dir})
                        return
                gen = sess["gen"]

                async def _do_copy():
                    try:
                        await be.copy(src, dst, progress_cb=_op_progress)
                        if sess.get("gen") == gen and not sess.get("cancelled"):
                            await ws.send_json({"type": "ok"})
                    except Exception:
                        if sess.get("gen") == gen and not sess.get("cancelled"):
                            await ws.send_json({"type": "error", "msg": "Copy failed"})
                    finally:
                        sess.pop("bg_task", None)

                sess["bg_task"] = asyncio.create_task(_do_copy())

            elif action == "upload_start":
                sess["cancelled"] = False
                p = norm_path(params["path"])
                if not params.get("confirm_overwrite"):
                    name = p.rsplit("/", 1)[-1]
                    if await be.exists(p):
                        await ws.send_json({"type": "file_exists", "name": name, "context": "upload"})
                        return
                sess["upload_buf"] = BytesIO()
                sess["upload_path"] = p
                await ws.send_json({"type": "upload_started"})

            elif action == "upload_chunk":
                buf = sess.get("upload_buf")
                if buf is None:
                    await ws.send_json({"type": "error", "code": "no_active_upload", "msg": "No active upload"})
                    return
                raw = base64.b64decode(params["data"])
                buf.write(raw)
                await ws.send_json({"type": "chunk_ok"})

            elif action == "upload_end":
                if sess.get("cancelled"):
                    return
                buf = sess.get("upload_buf")
                path = sess.get("upload_path")
                sess["upload_buf"] = None
                sess["upload_path"] = None
                if buf is None or path is None:
                    await ws.send_json({"type": "error", "code": "no_active_upload", "msg": "No active upload"})
                    return

                gen = sess["gen"]

                async def _do_write():
                    try:
                        await asyncio.wait_for(be.write_bytes(path, buf), timeout=300)
                        if sess.get("gen") == gen and not sess.get("cancelled"):
                            await ws.send_json({"type": "ok"})
                    except asyncio.CancelledError:
                        pass
                    except Exception:
                        if sess.get("gen") == gen and not sess.get("cancelled"):
                            await ws.send_json({"type": "error", "msg": "Upload failed"})
                    finally:
                        buf.close()
                        sess["write_task"] = None

                sess["write_task"] = asyncio.create_task(_do_write())

            elif action == "download_request":
                p = norm_path(params["path"])
                token = uuid.uuid4().hex
                download_tokens[token] = {"path": p, "sid": sess["sid"]}
                await ws.send_json({"type": "download_ready", "token": token})

            elif action == "download_zip_request":
                paths = [norm_path(p) for p in params.get("paths", [])]
                if not paths:
                    await ws.send_json({"type": "error", "msg": "No paths provided"})
                    return
                token = uuid.uuid4().hex
                download_tokens[token] = {"paths": paths, "sid": sess["sid"], "zip": True}
                await ws.send_json({"type": "download_ready", "token": token, "zip": True})

            elif action == "properties":
                p = norm_path(params["path"])
                parent = p.rsplit("/", 1)[0] if "/" in p else "/"
                items = await be.list_dir(parent)
                name = p.rsplit("/", 1)[-1]
                item = next((i for i in items if i.name == name), None)
                if item:
                    d = item.to_dict()
                    d["path"] = p
                    await ws.send_json({"type": "props_ok", "props": d})
                else:
                    await ws.send_json({"type": "error", "code": "item_not_found", "msg": "Item not found"})

            else:
                await ws.send_json({"type": "error", "msg": f"Unknown action: {action}"})

        except BackendError as e:
            if not sess.get("cancelled"):
                await ws.send_json({"type": "error", "msg": str(e)})
        except Exception as e:
            if not sess.get("cancelled"):
                await ws.send_json({"type": "error", "msg": str(e)})


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    ws.max_size = 2_147_483_648
    sid = str(uuid.uuid4())
    sess: dict = {"backend": None, "lock": asyncio.Lock(), "upload_buf": None, "upload_path": None, "sid": sid, "cancelled": False, "gen": 0, "write_task": None, "bg_task": None}
    sessions[sid] = sess
    try:
        while True:
            raw = await ws.receive_text()
            data = json.loads(raw)
            await handle_msg(ws, data, sess)
    except (WebSocketDisconnect, Exception):
        pass
    finally:
        sessions.pop(sid, None)
        for key in ("write_task", "bg_task"):
            t = sess.get(key)
            if t and not t.done():
                t.cancel()
                sess[key] = None
        ubuf = sess.get("upload_buf")
        if ubuf:
            try:
                ubuf.close()
            except Exception:
                pass
        be = sess.get("backend")
        if be:
            try:
                await be.disconnect()
            except Exception:
                pass


def no_cache(resp: Response):
    resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    resp.headers["Pragma"] = "no-cache"
    resp.headers["Expires"] = "0"
    if _USE_HEADERS:
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["X-Frame-Options"] = "DENY"
        resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


@app.get("/")
async def index():
    return no_cache(FileResponse(os.path.join(ROOT, "static", "index.html")))


@app.get("/style.css")
async def style():
    return no_cache(FileResponse(os.path.join(ROOT, "static", "style.css")))


@app.get("/app.js")
async def script():
    return no_cache(FileResponse(os.path.join(ROOT, "static", "app.js")))


@app.get("/lang.js")
async def lang_script():
    return no_cache(FileResponse(os.path.join(ROOT, "static", "lang.js")))


@app.get("/favicon.ico")
async def favicon():
    return no_cache(FileResponse(os.path.join(ROOT, "static", "favicon.ico")))


@app.get("/logo.png")
async def logo():
    return no_cache(FileResponse(os.path.join(ROOT, "static", "logo.png")))


@app.get("/i18n/{name}")
async def i18n_file(name: str):
    if ".." in name or "/" in name or "\\" in name or ":" in name:
        return JSONResponse({"error": "not found"}, status_code=404)
    path = os.path.join(ROOT, "static", "i18n", name)
    real = os.path.realpath(path)
    allowed = os.path.realpath(os.path.join(ROOT, "static", "i18n"))
    if not real.startswith(allowed) or not os.path.isfile(real):
        return JSONResponse({"error": "not found"}, status_code=404)
    return no_cache(FileResponse(real))


@app.get("/api/config")
async def api_config():
    cfg = load_config()
    return {
        "host": cfg.get("host") or "",
        "port": cfg.get("port") or 0,
        "passive": cfg.get("passive") if "passive" in cfg else None,
        "title": cfg.get("title") or "",
        "sessionLifetime": cfg.get("sessionLifetime") or 180,
    }


@app.get("/api/i18n")
async def api_i18n():
    i18n_dir = os.path.join(ROOT, "static", "i18n")
    if not os.path.isdir(i18n_dir):
        return []
    codes = []
    for f in os.listdir(i18n_dir):
        if f.endswith(".json"):
            codes.append(f[:-5])
    return sorted(codes)


@app.get("/api/download")
async def api_download(token: str):
    info = download_tokens.pop(token, None)
    if info is None:
        return {"error": "Invalid or expired token"}
    sess = sessions.get(info["sid"])
    if sess is None:
        return {"error": "Session expired"}
    auth = sess.get("auth_params")
    if auth is None:
        return {"error": "No auth data"}

    backend_type = auth.get("backend", "ftp")
    try:
        be = await BackendFactory.create(backend_type, auth)
    except BackendError as e:
        return {"error": f"Connect failed: {e}"}

    try:
        if info.get("zip"):
            paths = info["paths"]
            buf = BytesIO()
            now = datetime.now().strftime("%d%m%Y%H%M%S")
            zip_name = f"download-{now}.zip"

            collected = await be.collect_paths(paths)
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
                for fp, arc_name in collected:
                    data = await be.read_bytes(fp)
                    zf.writestr(arc_name, data.read())
            buf.seek(0)

            return StreamingResponse(buf, media_type="application/zip", headers={
                "Content-Disposition": f'attachment; filename="{zip_name}"'
            })

        else:
            path = info["path"]
            name = path.rsplit("/", 1)[-1] or "download"
            buf = await be.read_bytes(path)
            return StreamingResponse(buf, media_type="application/octet-stream", headers={
                "Content-Disposition": f'attachment; filename="{name}"'
            })

    except BackendError as e:
        return {"error": str(e)}
    finally:
        try:
            await be.disconnect()
        except Exception:
            pass


