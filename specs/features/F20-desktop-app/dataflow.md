# F-20: Desktop Application (Electron) — Data Flow

## App Startup Flow

```
User launches "Open Design.app"
    │
    ▼
Electron main process starts
    │
    ▼
Spawn sidecar daemon:
    child_process.spawn('daemon', [], { stdio: 'pipe' })
    │
    ▼
Poll Unix socket:
    /tmp/open-design/ipc/<namespace>/<app>.sock
    │
    ▼
Send IPC: STATUS
    ├── Response: { port: 7456, version: "0.8.0", pid: 1234 }
    └── Daemon confirmed running
    │
    ▼
(If OD_DESKTOP_AUTH=1):
    ├── Daemon generates auth secret
    └── Returns secret in STATUS response
    │
    ▼
Electron opens BrowserWindow:
    URL: http://localhost:7456/?_auth=<secret>
    │
    ▼
Web UI loads → App is ready
    Target: < 5 seconds total
```

## IPC Communication Flow

```
Electron Renderer (Web UI)
    │
    │ window.electronBridge.invoke('ipc', { command: 'SCREENSHOT' })
    │
    ▼
Electron Main Process
    │
    │ Unix socket write:
    │ { command: 'SCREENSHOT' }
    │
    ▼
Sidecar Daemon
    ├── Capture full-page screenshot
    └── Return: { screenshot: base64PNG }
    │
    ▼
Electron Main → Renderer
    └── Returns screenshot data
```

## Desktop Auth Gate Flow

```
Daemon boots (OD_DESKTOP_AUTH=1)
    │
    ├── crypto.randomBytes(32) → authSecret
    ├── Store in memory (not on disk)
    └── Include in STATUS response: { secret: "abc123…" }
    │
    ▼
Electron opens URL:
    http://localhost:7456/?_auth=abc123…
    │
    ▼
Every subsequent API call from renderer:
    Authorization: Bearer abc123…
    │
    ▼
Daemon validates:
    ├── Token matches current secret → Allow
    └── Token doesn't match → 401 Unauthorized
    │
    ▼
Import nonce (single-use anti-replay):
    POST /api/import/… includes nonce
    ├── First use → validate + consume (expires after 30s)
    └── Replay attempt → 401 Invalid nonce
```

## Data Migration Flow

```
OD_LEGACY_DATA_DIR="/path/to/.od" is set
    │
    ▼
Daemon boots → detects OD_LEGACY_DATA_DIR
    │
    ▼
Validate source:
    ├── Source has app.sqlite? → Proceed
    └── No app.sqlite → Error: "Invalid legacy data directory"
    │
    ▼
Check destination:
    ├── Desktop data dir already has data? → Error: "Refusing to merge"
    └── Empty → Proceed
    │
    ▼
Stage migration:
    ├── Copy .od/ → {appDataDir}/.od.staging/
    │
    ▼
Validate staging:
    └── Confirm app.sqlite accessible
    │
    ▼
Atomic promote:
    └── Rename .od.staging/ → .od/  (atomic operation)
    │
    ▼
Create marker file:
    .od/.migrated-from (prevents re-migration on next boot)
    │
    ▼
Daemon starts with migrated data
```

## Auto-Updater Flow

```
Electron app starts
    │
    ▼
autoUpdater.checkForUpdates()
    │
    ├── No update → continue
    └── Update available:
        │
        ├── autoUpdater.downloadUpdate() (background)
        └── UI: UpdaterPopup.tsx shows:
            "Update available. Downloading… (120 MB)"
            │
        Update downloaded
            │
            ▼
        "Update ready. Restart to install?" [Restart Now]
            │
        User clicks Restart Now
            │
            ▼
        autoUpdater.quitAndInstall()
        → App restarts with new version
```

## Sidecar Process Management

```
Electron Main:
    ├── sidecarProcess = child_process.spawn('daemon')
    ├── Monitor sidecarProcess.on('exit', …)
    │   └── If unexpected exit → restart sidecar (with retry limit)
    └── On app quit:
        └── IPC: SHUTDOWN → graceful daemon stop → then quit Electron
```

## Port Auto-Discovery

```
STATUS response: { port: 7456, … }
    │
    ▼
Electron stores port in memory
    │
    ▼
All API calls from renderer:
    → http://localhost:{port}/api/…
    (No hardcoded port — dynamic from STATUS)
```

## Folder Import Desktop Trust Gate

```
User: File Manager → drag folder into Open Design
    │
    ▼
Electron main process: shell.openPath dialog
    │
    ▼
Main: generate HMAC-signed desktop import token
    token = HMAC-SHA256(desktopSecret, folderPath + timestamp)
    │
    ▼
Main → POST /api/import/folder
    Headers: { X-OD-Desktop-Import-Token: token }
    Body: { baseDir: folderPath }
    │
    ▼
Daemon:
    ├── Verify HMAC signature
    ├── Check timestamp not expired
    └── Proceed with import (or reject if invalid)
```
