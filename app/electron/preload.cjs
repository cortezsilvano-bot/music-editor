/**
 * Preload bridge.
 *
 * Exposes a deliberately narrow API. The renderer gets explicit verbs and no
 * general filesystem access: it cannot read or write an arbitrary path unless
 * that path came from a folder (or file) the user picked in a native dialog.
 *
 * `window.desktop` is absent in a browser, which is how the app decides whether
 * desktop-only features exist at all.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  version: "2",

  /** Native folder picker. Resolves to null if the user cancels. */
  pickFolder: () => ipcRenderer.invoke("desktop:pickFolder"),

  /** Native audio-file picker for relocating a library row. Null on cancel. */
  pickAudioFile: () => ipcRenderer.invoke("desktop:pickAudioFile"),

  /** Recursively list audio files under a previously picked folder. */
  scanFolder: (folderPath) => ipcRenderer.invoke("desktop:scanFolder", folderPath),

  /** Read a file's bytes. Only paths under a picked folder are permitted. */
  readFile: (filePath) => ipcRenderer.invoke("desktop:readFile", filePath),

  /** Metadata-only existence check for a stored library path. */
  pathStatus: (filePath) => ipcRenderer.invoke("desktop:pathStatus", filePath),

  /**
   * Write ID3 frames, safely: the original is backed up, the new file is built
   * in a temporary copy, re-read to confirm the frames took, and only then
   * moved into place.
   */
  writeTags: (filePath, payload) => ipcRenderer.invoke("desktop:writeTags", filePath, payload),

  /** Start the repo stem service (explicit; never auto-started on launch). */
  startStemsService: () => ipcRenderer.invoke("desktop:startStemsService"),

  /** Stop a stem service this app started. External servers are left alone. */
  stopStemsService: () => ipcRenderer.invoke("desktop:stopStemsService"),

  /** Managed + HTTP health for the stem service. */
  stemsServiceStatus: () => ipcRenderer.invoke("desktop:stemsServiceStatus"),

  /** Pick and remember a server/ folder (must contain app.py). */
  pickStemsServerRoot: () => ipcRenderer.invoke("desktop:pickStemsServerRoot"),

  /** Set or clear the remembered server root (null clears). */
  setStemsServerRoot: (folderPath) => ipcRenderer.invoke("desktop:setStemsServerRoot", folderPath),

  /** Append one line to the rotating userData log file. */
  appendLog: (line) => ipcRenderer.invoke("desktop:appendLog", line),

  /** Absolute path of the active log file (and its folder). */
  logPath: () => ipcRenderer.invoke("desktop:logPath"),

  /** Reveal the logs folder in the OS file manager. */
  openLogFolder: () => ipcRenderer.invoke("desktop:openLogFolder"),
});
