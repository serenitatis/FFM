# FFM — Fast File Manager

FTP-over-WebSocket file manager. Python 3.12+ FastAPI backend, vanilla JS client + Tailwind CSS (local).

## Commands
```sh
pip install -r requirements.txt
uvicorn server.main:app --host 0.0.0.0 --port 8000 --ws-ping-interval 0
# or: server.bat / server.sh
```
Validate: `python -c "import py_compile; py_compile.compile('server/main.py', doraise=True); py_compile.compile('server/backends/base.py', doraise=True); py_compile.compile('server/backends/ftp_backend.py', doraise=True)" && node -e "new Function(require('fs').readFileSync('static/lang.js','utf8')); new Function(require('fs').readFileSync('static/app.js','utf8'))"`
No test/lint/typecheck — validate only.

## Critical: `--ws-ping-interval 0`
Without this flag uvicorn pings idle WebSockets, causing `WebSocketDisconnect` during long operations (copy, rmdir, upload).

## Critical: cancel mechanism
Copy/move/rmdir run in `asyncio.create_task` (bg_task) so the message loop stays responsive. Lock released immediately; client queue advances on `ok`.

Cancel increments `sess["gen"]`. bg_tasks capture `gen` at creation and check `sess.get("gen") == gen` before any WS message. Stale tasks fall silent. `FTPBackend.cancel()` shuts down + closes sockets + `ftp.close()`. `sess["backend"]` set to `None`; next request auto-reconnects from saved `auth_params`.

**Never run two FTP operations concurrently on the same backend** — ftplib is not thread-safe.

## Critical: FTP keepalive via NOOP
FTP servers drop idle connections (~600s). Client sends `ping` via WebSocket every 30s. Server responds `pong` immediately, then fires a background task (`asyncio.ensure_future`) that acquires the lock and calls `FTPBackend.noop()` → `voidcmd("NOOP")` via `to_thread`. Errors silently ignored. This keeps the control channel alive as long as the browser tab is open.

## WebSocket protocol
- C→S: `{"action":"...", "params":{...}}`, S→C: `{"type":"...", ...}`
- `ping` → `pong` (no lock needed; also triggers FTP NOOP as a background task).
- Upload flow: `upload_start` → `upload_chunk` (10 MB base64) → `upload_end` (300s timeout, background `write_task`).
- All user paths pass through `norm_path()` (strips `..`, `.`, `\\`).
- `rename(source, dest)` uses full paths. `move(source, dest)` appends source filename to dest dir.
- `file_exists` carries `context: "upload"|"move"|"copy"` + `source` + `dest`.
- `download_request` / `download_zip_request` → `{"type":"download_ready","token":"..."}`. Single-use token, consumed via `/api/download?token=`.
- Error codes: `not_authenticated`, `no_active_upload`, `item_not_found`.

## Backend architecture
- `FileBackend` (ABC) in `server/backends/base.py`. Abstract: `connect`, `disconnect`, `getcwd`, `list_dir`, `mkdir`, `delete`, `delete_dir`, `rename`, `read_bytes`, `write_bytes`, `exists`. Default impl: `rmdir`, `copy` (recursive, 2MB-throttled progress), `cancel`, `collect_paths`, `noop` (pass).
- `BackendFactory` in `server/backends/__init__.py`: plugin registry via `register("name", Class)`. Currently only `"ftp"` → `FTPBackend`.
- `FTPBackend` wraps `ftplib.FTP` via `asyncio.to_thread`. `TYPE I` on connect. Dir rename fallback: copy+delete. `noop()` sends `voidcmd("NOOP")`.
- One FTP connection per session. `/api/download` creates a fresh backend from saved `auth_params`.

## Config (`config/config.yaml`)
Hand-parsed via `partition(":")` — no PyYAML. Bool/int auto-detected. Empty/missing file → login fields editable.
Keys: `backend` (default `"ftp"`), `host`, `port`, `passive`, `title`, `use_headers` (false by default; enables `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` on static responses).

## Security notes
- Path traversal in `/i18n/{name}` prevents `..`, `/`, `\`, `:` in filename + `realpath` boundary check.
- XSS prevention: `esc()` in `static/app.js` (`&`, `<`, `>`, `"`, `'` → HTML entities) wraps all FTP-originated data in `innerHTML`.
- Security headers (`nosniff`, `DENY`, `no-referrer`) only active when `use_headers: true` in config. Default off because `FileResponse` + `nosniff` on Windows may serve `.js` as `text/plain` (mimetypes misdetection).
- FTP credentials stored in session memory + browser `sessionStorage`. No encryption.

## Session management
- `sessions: dict[str, dict]` (in-memory UUID keys). Fields: `backend`, `lock`, `gen`, `cancelled`, `upload_buf`, `upload_path`, `auth_params`, `sid`, `write_task`, `bg_task`.
- `auth_params` saved after auth for auto-reconnect and `/api/download`.

## Client (`static/app.js`)
- `lang.js` loaded first — provides `__()`, `_loadI18n()`, `errorCodeMap`.
- **Ping**: `setInterval(() => send('ping'), 30000)` in `ws.onopen`, cleared on `ws.onclose`.
- **Select mode**: checkboxes via `Ctrl+A` / `Ctrl+click`. Copy/cut/delete/download auto-exit.
- **Clipboard**: `{ paths: [...], cut: bool }`. Paste serial via `pasteNext()`.
- **Op progress** in `#op-bar`: spinner + verb + filename + bar + %. Hides 500ms after `ok`.
- **State in sessionStorage**: auth, sort, theme, lang.
- **Cache-busting**: `app.js?v=4`, `lang.js?v=4` hardcoded in `index.html`.
- `esc()` function for HTML-escaping user-controlled data in `innerHTML`.

## Tailwind / i18n / Docker
- Local `tailwind.min.js` in `static/assets/tailwindui/`. No build step. Inline config.
- **No arbitrary values** (`w-[55%]` etc.) on `<col>` — local CDN won't generate them. Use CSS `th:nth-child()` instead.
- Dark mode: `html.dataset.theme` → MutationObserver syncs `dark` class.
- i18n: add JSON to `static/i18n/` + restart. `__(key, arg0...)` replaces `{0}`, `{1}`. HTML attrs: `data-i18n`, `data-i18n-placeholder`, `data-i18n-title`. Missing key → English.
- Docker: `docker compose up -d`. Config volume-mounted; edits picked up on page reload.
- All static routes: `Cache-Control: no-cache`.
