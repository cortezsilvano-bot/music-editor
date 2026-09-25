/**
 * Electron main process.
 *
 * The renderer is the same React build the browser runs - nothing is forked for
 * desktop. Two details matter:
 *
 * - The page is served over a custom `app://` protocol rather than `file://`.
 *   Vite emits ES-module workers, and Chromium refuses to load a module worker
 *   from a file:// origin, so the analysis worker would silently never start.
 *   A custom protocol gives the page a real, secure origin, which IndexedDB
 *   also needs in order to persist between launches.
 * - Node integration is off and context isolation is on. The renderer is
 *   ordinary web code and has no reason to touch Node.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const files = require("./files.cjs");
const stemsService = require("./stemsService.cjs");
const log = require("./log.cjs");
const DIST = path.join(__dirname, "..", "dist");
const SCHEME = "app";
const AUDIO_FILTERS = [
  {
    name: "Audio",
    extensions: ["mp3", "wav", "flac", "ogg", "oga", "m4a", "aac", "aiff", "aif"],
  },
];
// Standard scheme: required before `app.whenReady()` so the origin is treated
// as secure and gets its own persistent storage partition.
protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);
/** Resolve a request path to a file inside dist, refusing anything outside it. */
function resolveWithinDist(requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(DIST, relative === "" ? "index.html" : relative);
  if (candidate !== DIST && !candidate.startsWith(DIST + path.sep)) return null;
  return candidate;
}
function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#08080b",
    title: "Music Editor",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });
  // Avoid a white flash before the dark page paints.
  window.once("ready-to-show", () => window.show());
  // External links open in the real browser, not inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith(`${SCHEME}://local/`)) event.preventDefault();
  });
  void window.loadURL(`${SCHEME}://local/index.html`);
  return window;
}
app.whenReady().then(() => {
  protocol.handle(SCHEME, (request) => {
    const { pathname, hostname } = new URL(request.url);
    if (hostname !== "local") return new Response("Not found", { status: 404 });
    let file;
    try { file = resolveWithinDist(pathname); } catch { return new Response("Bad request", { status: 400 }); }
    if (!file) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(file).toString());
  });
  registerFileHandlers();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "File",
        submenu: [{ role: "quit" }],
      },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
/**
 * IPC for filesystem access and optional stem-service supervision.
 *
 * Every handler returns a plain result object rather than throwing across the
 * boundary, so a rejected promise in the renderer always means the bridge
 * itself failed, not that the user picked an awkward file.
 *
 * The stem service is never started automatically on launch.
 */
function registerFileHandlers() {
  ipcMain.handle("desktop:pickFolder", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Choose a music folder",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const folder = result.filePaths[0];
    // Picking a folder is what grants access to it and everything beneath.
    files.grantRoot(folder);
    return folder;
  });
  ipcMain.handle("desktop:pickAudioFile", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Locate audio file",
      properties: ["openFile"],
      filters: AUDIO_FILTERS,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    files.grantRoot(path.dirname(filePath));
    return filePath;
  });
  ipcMain.handle("desktop:scanFolder", async (_event, folderPath) => {
    try {
      return { ok: true, ...(await files.scanFolder(folderPath)) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("desktop:readFile", async (_event, filePath) => {
    try {
      return { ok: true, data: await files.readFile(filePath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("desktop:pathStatus", async (_event, filePath) => {
    try {
      return await files.pathStatus(filePath);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("desktop:writeTags", async (_event, filePath, payload) => {
    try {
      return await files.writeTags(filePath, payload);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("desktop:startStemsService", async () => {
    try {
      return await stemsService.start();
    } catch (error) {
      return { ok: false, reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("desktop:stopStemsService", async () => {
    try {
      return await stemsService.stop();
    } catch (error) {
      return { ok: false, reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("desktop:stemsServiceStatus", async () => {
    try {
      return await stemsService.status();
    } catch (error) {
      return { reachable: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("desktop:pickStemsServerRoot", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(window, {
      title: "Choose stem server folder (must contain app.py)",
      properties: ["openDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, cancelled: true, serverRoot: stemsService.serverDir() };
    }
    return stemsService.setServerRoot(result.filePaths[0]);
  });
  ipcMain.handle("desktop:setStemsServerRoot", async (_event, folderPath) => {
    try {
      return stemsService.setServerRoot(folderPath ?? null);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle("desktop:appendLog", async (_event, line) => log.append(line));
  ipcMain.handle("desktop:logPath", async () => log.getPath());
  ipcMain.handle("desktop:openLogFolder", async () => log.openFolder());
}
app.on("window-all-closed", () => {
  // Windows and Linux quit with the last window; macOS convention differs.
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  stemsService.stopSync();
});
