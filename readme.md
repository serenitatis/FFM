# FFM — Fast File Manager

A web file manager that is essentially a wrapper over FTP. The idea is that a user logs into the web file manager, enters their FTP credentials, and gains access to their files according to their permissions. This way, all permission-related complexity is handled and configured once on the FTP server side. I know Filestash exists — it's good and convenient and does everything needed. Except… it can't copy and move folders and files. It can't do the work a file manager should do by default.

## Features

- View, create, delete folders/files
- Drag-and-drop upload
- Download via browser
- Move / Copy with overwrite confirmation
- File properties
- Dark/Light theme (auto/light/dark)
- Multilingual (i18n), auto-language detection
- Cookies — authorization, sorting, theme persist across F5 and browser restarts
- Configurable session lifetime
- Mobile device support
- Standalone or Docker deployment
- Reverse-proxy support

## Tech Stack

Python 3.12+, FastAPI, uvicorn, websockets, ftplib (stdlib), Vanilla HTML/CSS/JS, Tailwind CSS, Font Awesome

## Quick Start

```bash
# Windows
python -m venv .venv
.venv\Scripts\activate

# Linux / macOS
# python -m venv .venv
# source .venv/bin/activate

pip install -r requirements.txt
uvicorn server.main:app --host 0.0.0.0 --port 8000
```

Open http://localhost:8000, enter your FTP server credentials.

## Docker

```bash
docker run -d --restart unless-stopped --name ffm -p 8000:8000 -v ./config:/app/config ghcr.io/serenitatis/ffm:stable
```

The `config/config.yaml` configuration is mounted as a volume — edits on the host are applied after refreshing the page in the browser.

### Manual Build

```bash
docker build -t ffm .
docker run -d --restart unless-stopped --name ffm -p 8000:8000 -v ./config:/app/config ffm
```

## Configuration

`config/config.yaml` — default FTP host/port/mode and application title setting.
If the file is missing or the host, port, passive fields are empty — user input is expected.

### Session lifetime

Auth credentials and UI state (sorting, theme, language, sidebar width) are stored in browser cookies.
Cookie lifetime is controlled by `sessionLifetime` (in minutes). If not set, the default is 43200 minutes (30 days).
Cookies persist across page reloads and browser restarts; each successful login refreshes the lifetime.

### Example File

```yaml
backend: ftp # Backend used for file operations. Currently FTP only, so the parameter is optional.
host: "192.168.1.1" # Host to connect to
port: 2121          # Custom FTP connection port
passive: true       # Enable passive FTP mode
title: "File Manager" # Custom application title
sessionLifetime: 43200 # Cookie lifetime in minutes (default 43200 = 30 days)
```
## License

This project is licensed under the MIT License.