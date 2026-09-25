# Windows desktop build

The desktop app is the **same React build the browser runs**, wrapped in
Electron. Nothing is forked for desktop: `app/dist` is the renderer in both
cases, so there is one codebase and one test suite.

## Building

```powershell
cd app
npm run desktop:build     # web build + NSIS installer
```

Output lands in `app/release` (versioned subfolders such as `release/0.3.2`):

| File | Purpose |
|---|---|
| `MusicEditor-Setup-<version>.exe` | the installer (~112 MB) |
| `MusicEditor-Setup-<version>.exe.blockmap` | delta-update map, used by future auto-update |
| `win-unpacked/` | the unpacked app, runnable directly without installing |

Other scripts:

| Script | Does |
|---|---|
| `npm run desktop:dev` | build the web assets and launch Electron against them |
| `npm run desktop:dir` | package to `win-unpacked` only, skipping the installer |
| `npm run electron` | launch Electron against whatever is already in `dist` |
| `npm run test:desktop` | Playwright smoke against a temporary profile |

## Installer behaviour

NSIS, configured in the `build.nsis` block of `app/package.json`:

- **Per-user install** (`perMachine: false`) — no admin prompt.
- **Assisted, not one-click** (`oneClick: false`) — the user sees a wizard and
  can choose the install directory.
- Creates a desktop shortcut and a Start Menu entry, both named "Music Editor".
- Registers an uninstaller as "Music Editor <version>" in Apps & Features.

## Why a custom protocol instead of `file://`

`electron/main.cjs` serves the renderer over an `app://` scheme rather than
loading `index.html` from disk. Two reasons, both of which produce a silently
broken app if ignored:

1. **ES-module workers.** Vite emits the analysis worker as an ES module.
   Chromium refuses to load a module worker from a `file://` origin, so the
   worker would never start and every track would sit at "queued" forever.
2. **Storage persistence.** `file://` has an opaque origin. IndexedDB either
   fails or is scoped unpredictably, so the library would not survive a
   restart. A registered standard scheme gives the page a real, secure origin.

The handler resolves every request inside `dist` and refuses anything that
escapes it, so a crafted URL cannot read arbitrary files.

## Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. The
  renderer is ordinary web code with no direct Node access.
- External links open in the system browser rather than inside the app frame.
- A **preload bridge** (`electron/preload.cjs`) exposes a narrow `window.desktop`
  API: folder/file pickers, recursive scan, permitted reads, path existence
  checks, safe tag writes, and optional stem-service start/stop/status plus
  server-root selection. Arbitrary filesystem access is not exposed;
  reads/writes require a user-picked grant (except metadata-only `pathStatus`
  for detecting missing library paths).

## Native filesystem and tags

Implemented:

- **Import folder** with recursive audio scanning under a picked directory.
- **Tag writing** back to MP3/FLAC with backup + temp + verify + atomic rename
  (`electron/files.cjs`, `electron/flac.cjs`, `TagWritePanel`).
- **Source path** stored as `filePath` for folder imports; **Relocate** updates
  the path when the new file's SHA-256 matches (keeps analysis).
- Audio Blobs are still stored in IndexedDB for offline playback; paths unlock
  tag write and relocate, they do not yet replace Blob storage.

## Stem service (optional)

The Stems panel talks to `http://localhost:8787`. You can:

1. Start it yourself with `server/run.ps1`, or
2. Use **Start service** in the desktop Stems panel (does **not** auto-start on
   app launch; does not bundle Demucs weights or a Python venv).

### How the app finds `server/`

Resolution order in `electron/stemsService.cjs`:

1. User override (Choose server folder… / persisted under userData) or env
   `MUSIC_EDITOR_SERVER_ROOT`
2. When packaged: `process.resourcesPath/server` (copied by electron-builder
   `extraResources`)
3. Checkout layout: `../server` relative to `app/`

`extraResources` copies **server source + requirements + run scripts only**.
It excludes `__pycache__`, `.venv*`, `jobs/`, checkpoints/weights (`.pth` /
`.ckpt` / `.pt`), and similar caches. **PyTorch and Demucs model weights are
never bundled.**

### Packaged install one-liner

After installing the desktop app (or from an unpacked `resources/server`):

```powershell
cd "$env:LOCALAPPDATA\Programs\Music Editor\resources\server"
# path may vary with install dir — the Stems panel shows the resolved path
pip install -r requirements.txt
# optional Demucs/torch already listed in requirements; DSP works without them
```

Or point the app at a checkout:

```powershell
$env:MUSIC_EDITOR_SERVER_ROOT = "F:\Dev_apps\Music_editor\server"
```

Stop only affects a process this app started. An already-running external
server is left alone.

## Code signing

**The installer is not signed.** `Get-AuthenticodeSignature` reports
`NotSigned`.

Windows SmartScreen will therefore show "Windows protected your PC" on first
run, and the user has to click *More info → Run anyway*. This is expected for
an unsigned build and is not a defect in the package.

Signing needs an Authenticode certificate (OV, or EV to bypass SmartScreen
reputation immediately). Once you have one, set `CSC_LINK` and `CSC_KEY_PASSWORD`
in the environment and electron-builder will sign automatically — no config
change needed.

## Known build wrinkles

- **`ELECTRON_RUN_AS_NODE`.** VS Code sets this in integrated terminals. If it
  is set, `electron .` runs the main script under plain Node and
  `require("electron")` returns a path string instead of the module, so startup
  fails with `Cannot read properties of undefined`. Clear it before building or
  launching:
  `Remove-Item Env:ELECTRON_RUN_AS_NODE`.
- **`EPERM ... unlink ffmpeg.dll`.** A previous Electron process still holds
  files in `release\win-unpacked`. Close any running instance and delete
  `release` before rebuilding.
- Source maps are included in the package. They cost a few MB against a ~112 MB
  installer and make a production stack trace readable, so they are kept.
- Packaged stem supervise still requires a **system Python** and
  `pip install -r requirements.txt` (or Choose server folder / env override).
  Physical Demucs GPU/OOM and Authenticode remain separate acceptance gates.
