/**
 * Headless smoke check for the desktop build.
 *
 * Loads the real app in a hidden window and asks the renderer what it can see.
 * This is the only way to confirm the preload bridge and the custom protocol
 * actually work: both fail silently in ways a build log never shows.
 *
 *   electron electron/smoke.cjs
 *
 * Exits 0 if every check passes, 1 otherwise.
 */
const { app, BrowserWindow, net, protocol } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DIST = path.join(__dirname, "..", "dist");
const SCHEME = "app";

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function resolveWithinDist(requestPath) {
  const decoded = decodeURIComponent(requestPath);
  const relative = decoded.replace(/^\/+/, "");
  const candidate = path.resolve(DIST, relative === "" ? "index.html" : relative);
  if (candidate !== DIST && !candidate.startsWith(DIST + path.sep)) return null;
  return candidate;
}

const checks = [];
function check(name, pass, detail) {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  :: " + detail : ""}`);
}

app.whenReady().then(async () => {
  protocol.handle(SCHEME, (request) => {
    const file = resolveWithinDist(new URL(request.url).pathname);
    if (!file) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.cjs"),
    },
  });

  const pageErrors = [];
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") pageErrors.push(event.message);
  });

  try {
    await window.loadURL(`${SCHEME}://local/index.html`);
    check("page loads over app:// protocol", true);

    // Give React a moment to mount and the worker to spin up.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    const probe = await window.webContents.executeJavaScript(`
      (() => ({
        rootChildren: document.getElementById("root")?.childElementCount ?? 0,
        heading: document.querySelector("h1")?.textContent ?? null,
        bridge: typeof window.desktop,
        bridgeKeys: window.desktop ? Object.keys(window.desktop).sort() : [],
        hasNodeRequire: typeof window.require,
        origin: window.location.origin,
        indexedDb: typeof indexedDB,
        worker: typeof Worker,
        importFolderButton: [...document.querySelectorAll("button")]
          .some(b => b.textContent.trim() === "Import folder"),
        views: [...document.querySelectorAll(".views button")].map(b => b.textContent.trim()),
        audioWorklet: typeof AudioWorkletNode === "function",
      }))()
    `);

    // The original app is embedded as the Studio tab and must load under the
    // desktop's app:// origin as well as over http.
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const studio = await window.webContents.executeJavaScript(`
      (() => {
        const f = document.querySelector("iframe.studio-frame");
        try {
          const d = f && f.contentDocument;
          return { present: !!f, kids: d && d.getElementById("root") ? d.getElementById("root").childElementCount : 0,
                   text: d ? (d.body.innerText || "").slice(0, 60) : "" };
        } catch (e) { return { present: !!f, kids: 0, text: "blocked: " + e }; }
      })()
    `);
    check("Studio tab embeds the original app", studio.present && studio.kids > 0, studio.text.replace(/\s+/g, " "));
    check("React mounted", probe.rootChildren > 0, `root has ${probe.rootChildren} child(ren)`);
    check("app heading rendered", probe.heading === "Music Editor", String(probe.heading));
    check("preload bridge exposed", probe.bridge === "object", probe.bridge);
    check(
      "bridge exposes the expected verbs",
      ["pickFolder", "readFile", "scanFolder", "version", "writeTags"].every((k) =>
        probe.bridgeKeys.includes(k),
      ),
      probe.bridgeKeys.join(", "),
    );
    check("Node is NOT reachable from the renderer", probe.hasNodeRequire === "undefined", probe.hasNodeRequire);
    check("origin is a real secure origin", probe.origin.startsWith("app://"), probe.origin);
    check("IndexedDB available", probe.indexedDb === "object");
    check("Workers available", probe.worker === "function");
    check("desktop folder import is offered", probe.importFolderButton === true);
    check(
      "all three views are present",
      ["Library", "Mix", "Duplicates"].every((v) => probe.views.includes(v)),
      probe.views.join(", "),
    );
    check("AudioWorklet is available for the decks", probe.audioWorklet === true);

    // Switch to Mix Mode and confirm the worklet module actually loads: a
    // failed addModule leaves the panel stuck on "Starting the audio engine".
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll(".views button")]
        .find(b => b.textContent.trim() === "Mix")?.click(); true
    `);
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const mix = await window.webContents.executeJavaScript(`
      (() => ({
        decks: document.querySelectorAll(".deck").length,
        crossfader: document.querySelectorAll(".crossfader").length,
        stillStarting: document.body.textContent.includes("Starting the audio engine"),
        engineError: [...document.querySelectorAll(".conf.red")].map(e => e.textContent).join(" | "),
      }))()
    `);
    check("mix mode renders two decks", mix.decks === 2, `found ${mix.decks}`);
    check("crossfader present", mix.crossfader === 1);
    check("deck audio engine started", mix.stillStarting === false, mix.engineError || "");

    // Device routing and the new transport controls.
    const extra = await window.webContents.executeJavaScript(`
      (async () => {
        const outs = (await navigator.mediaDevices.enumerateDevices())
          .filter(d => d.kind === "audiooutput");
        const labels = [...document.querySelectorAll(".deck label")].map(l => l.textContent.trim());
        return {
          setSinkId: typeof AudioContext.prototype.setSinkId,
          outputCount: outs.length,
          namedOutputs: outs.filter(d => d.label).length,
          slipToggle: labels.some(l => l.startsWith("Slip")),
          rollRow: [...document.querySelectorAll(".deck .ge-label")]
            .some(e => e.textContent.trim() === "Roll"),
          deviceSelects: document.querySelectorAll(".crossfader select").length,
        };
      })()
    `);
    check("AudioContext.setSinkId is available", extra.setSinkId === "function");
    check(
      "audio outputs enumerate with names",
      extra.outputCount > 0 && extra.namedOutputs > 0,
      `${extra.namedOutputs}/${extra.outputCount} named`,
    );
    check("output device selector shown", extra.deviceSelects === 1);
    check("slip toggle present on decks", extra.slipToggle === true);
    check("loop roll row present on decks", extra.rollRow === true);
    // Back to the library. With an empty library there is no selected track,
    // so the per-track panels correctly do not render - that is what is checked
    // here. The stems panel itself is covered by unit tests and by a live test
    // against the running service.
    await window.webContents.executeJavaScript(`
      [...document.querySelectorAll(".views button")]
        .find(b => b.textContent.trim() === "Library")?.click(); true
    `);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const library = await window.webContents.executeJavaScript(`
      (() => ({
        emptyState: document.body.textContent.includes("Select a track"),
        noStrayPanels: [...document.querySelectorAll("h3")]
          .map(h => h.textContent.trim())
          .filter(t => ["Stems", "Write tags to file", "Export"].includes(t)).length,
      }))()
    `);
    check("library view returns to its empty state", library.emptyState === true);
    check(
      "per-track panels do not render without a selection",
      library.noStrayPanels === 0,
      `${library.noStrayPanels} rendered`,
    );

    check("no renderer errors", pageErrors.length === 0, pageErrors.slice(0, 3).join(" | "));
  } catch (error) {
    check("smoke run completed", false, String(error));
  }

  const failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  app.exit(failed === 0 ? 0 : 1);
});
