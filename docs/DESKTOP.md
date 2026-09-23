# Windows desktop build

The desktop app is the **same React build the browser runs**, wrapped in
Electron. Nothing is forked for desktop: `app/dist` is the renderer in both
cases, so there is one codebase and one test suite.

## Building

```powershell
cd app
npm run desktop:build     # web build + NSIS installer
```

Output lands in `app/release`:

| File | Purpose |
|---|---|
| `MusicEditor-Setup-0.2.0.exe` | the installer (~108 MB) |
| `MusicEditor-Setup-0.2.0.exe.blockmap` | delta-update map, used by future auto-update |
| `win-unpacked/` | the unpacked app, runnable directly without installing |

Other scripts:

| Script | Does |
|---|---|
| `npm run desktop:dev` | build the web assets and launch Electron against them |
| `npm run desktop:dir` | package to `win-unpacked` only, skipping the installer |
| `npm run electron` | launch Electron against whatever is already in `dist` |

## Installer behaviour

NSIS, configured in the `build.nsis` block of `app/package.json`:

- **Per-user install** (`perMachine: false`) — no admin prompt.
- **Assisted, not one-click** (`oneClick: false`) — the user sees a wizard and
  can choose the install directory.
- Creates a desktop shortcut and a Start Menu entry, both named "Music Editor".
- Registers an uninstaller as "Music Editor 0.2.0" in Apps & Features.

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
  renderer is ordinary web code with no access to Node.
- External links open in the system browser rather than inside the app frame.
- There is no preload bridge, because nothing in the renderer currently needs
  privileged access. Adding one is the route to real filesystem features —
  see below.

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

## What the desktop shell unlocks later

These are not implemented yet, but Electron makes them possible where the
browser could not:

- **Real folder import** with recursive scanning of a chosen directory.
- **Tag writing** back to the user's files, which Phase G specifies and a
  browser cannot do at all.
- **Missing-file detection and relocation**, since real paths exist.
- **Storing paths instead of audio Blobs**, removing the current duplication of
  every track's bytes into IndexedDB.

Each needs a preload bridge exposing a narrow, explicit API — not
`nodeIntegration`.

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
- Source maps are included in the package. They cost a few MB against a 108 MB
  installer and make a production stack trace readable, so they are kept.
