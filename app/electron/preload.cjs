/**
 * Preload bridge.
 *
 * Exposes a deliberately narrow API. The renderer gets four verbs and no
 * general filesystem access: it cannot name an arbitrary path to read or write
 * unless that path came from a folder the user picked in a native dialog.
 *
 * `window.desktop` is absent in a browser, which is how the app decides whether
 * desktop-only features exist at all.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  version: "1",

  /** Native folder picker. Resolves to null if the user cancels. */
  pickFolder: () => ipcRenderer.invoke("desktop:pickFolder"),

  /** Recursively list audio files under a previously picked folder. */
  scanFolder: (folderPath) => ipcRenderer.invoke("desktop:scanFolder", folderPath),

  /** Read a file's bytes. Only paths under a picked folder are permitted. */
  readFile: (filePath) => ipcRenderer.invoke("desktop:readFile", filePath),

  /**
   * Write ID3 frames, safely: the original is backed up, the new file is built
   * in a temporary copy, re-read to confirm the frames took, and only then
   * moved into place.
   */
  writeTags: (filePath, payload) => ipcRenderer.invoke("desktop:writeTags", filePath, payload),
});
