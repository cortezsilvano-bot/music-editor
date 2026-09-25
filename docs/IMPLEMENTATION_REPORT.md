# Implementation report - version 0.3.2

Updated 2026-09-23. Current source is the React/TypeScript app in `app/`,
with an Electron desktop shell and an optional Python stem service in `server/`.
Historical detail for the September 22-23 upgrade tranche lives in
[Upgrade implementation session](UPGRADE_SESSION_2026-09-23.md). The 0.2.0-era
completion audit remains in
[IMPLEMENTATION_REPORT_AUDIT_2026-09-21.md](IMPLEMENTATION_REPORT_AUDIT_2026-09-21.md).

## How to run (Windows)

From `F:\Dev_apps\Music_editor`:

```powershell
cd app
npm install
npm run desktop:dev          # build renderer + launch Electron
# optional stem service (also Start-able from the Stems panel in desktop):
cd ..\server
pip install -r requirements.txt
.\run.ps1
```

Useful commands (from `app/`):

| Script | Purpose |
|---|---|
| `npm test` / `npm run lint` / `npm run build` | unit checks |
| `npm run test:desktop` | Electron smoke (Playwright) |
| `npm run verify` | lint + test + build + desktop/job/catalog smokes |
| `npm run verify:stems` | verify + Python stem tests + stems smoke |
| `npm run desktop:build` | NSIS installer under `app/release/` |

Installer artifacts include `app/release/0.3.2/MusicEditor-Setup-0.3.2.exe`
(and retained 0.2.0 / 0.3.0 / 0.3.1 builds). The installer is unsigned.

## Current capability (0.3.2 + this session)

Already present before this session (do not re-implement):

- Dexie schema through **v13** (durable jobs, leases, stem cache, paged catalog)
- Native file bridge: preload/IPC (`pickFolder`, `scanFolder`, `readFile`, `writeTags`)
- Safe atomic tag write with backups (MP3 + FLAC)
- Multi-window queue leases, configurable analysis timeout, bounded PCM cache
- Mix Mode (two decks, EQ, crossfader, sync, loops, hot cues, WSOLA)
- Stems client (`StemsPanel` / `stems/service.ts` / `stems/jobs.ts`) against `localhost:8787`
- Fingerprints + Duplicates panel, library virtualization, output device selection
- Full v0.2.0 analysis/library checklist (queue cancel, grid lock, cues, true peak, etc.)

Added in this session:

- **Mastering panel discoverability (2026-09-24 UX)** - `MasteringPanel` moved to the top of the right inspector (under Play transport / before Reanalyse + analysis facts; also first after empty state). Bypass checkbox + visible hint (bypass default on). Accent left border. DSP/defaults unchanged; monitor-only. Mix Mode compact strip kept.


- **Structured logging** - `app/src/util/logger.ts` (`createLogger(scope)`). Tagged JSON lines via `console.warn` / `console.error`. Optional `music-editor.logLevel` (`"debug"`|`"info"`|`"warn"`|`"error"`, JSON via localStorage). Light hooks on scheduler start/fail, tag write, stem request.
- **Feature flags** - localStorage keys (default **ON**):
  - `featureMixMode`
  - `featureStems`
  - `featureDuplicates`
  Helpers in `app/src/ui/features.ts`. View buttons / panels are gated in `App.tsx`.
- **Missing-file / Relocate** - `desktop:pathStatus`, `desktop:pickAudioFile`, `FileLocationPanel`, `relocateTrackFile` (keeps analysis when SHA-256 matches; hash mismatch refuses and asks for a normal import).
- **Electron-supervised stem service** - `electron/stemsService.cjs` + IPC `startStemsService` / `stopStemsService` / `stemsServiceStatus`. **Does not auto-start on launch.** Start/Stop controls in Stems panel; external servers still work. Spawns repo `server/` uvicorn; does not bundle Demucs weights. Stop-on-quit only for a process this app started.

## Feature flag keys

| Key | Default | Effect when off |
|---|---|---|
| `featureMixMode` | true | Hide Mix view |
| `featureStems` | true | Hide Stems panel |
| `featureDuplicates` | true | Hide Duplicates view |

Set via DevTools, e.g. `localStorage.setItem("music-editor.featureMixMode", "false")`, then reload ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â or use the in-app Settings panel (no DevTools required).

Added after the logging/flags/relocate session (still 0.3.2 software):

- **Settings UI** - `SettingsPanel` toggles `featureMixMode` / `featureStems` / `featureDuplicates` and log level (`music-editor.logLevel` via `useSetting("logLevel")`). Helpers `getLogLevel` / `setLogLevel` in `logger.ts`.
- **Export / tag-write review gate** - `export/reviewGate.ts`: catalog `review` flags skip those tracks from Export (default: no override; clear tracks still export). Tag write blocks when `needsReview` unless "Write despite review".
- **Batch missing-file scan** - `MissingFilesPanel` + `desktop/batchRelocate.ts`: scan stored paths; Relocate folder matches unique `relativePath` then unique basename; still refuses hash mismatches via `relocateTrackFile`.
- **Waveform zoom/pan** - `WaveformView` + `ui/waveformPeaks.ts` (view window sample/zoom/pan; playhead mapped to window). Wheel zoom, Shift+wheel/drag pan, Home/reset.

## Shipped this session (still 0.3.2 software; acceptance gates open)

- **In-app playlists** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Dexie v14 `playlists` table; create/rename/delete; add/remove/reorder selected track; open as library filter (`PlaylistsPanel` + `db/playlists.ts`). Migration test for v13ÃƒÂ¢Ã¢â‚¬Â Ã¢â‚¬â„¢v14.
- **File log sink (Electron)** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â append-only `userData/logs/music-editor.log` with 2 MiB rotation (1 backup); preload/IPC `appendLog` / `logPath` / `openLogFolder`; Settings shows path + open folder; default ON in Electron, OFF in browser.
- **On-disk peak pyramid** ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â Dexie `peakPyramids` keyed by content hash; built on first waveform view; WaveformView selects level by zoom span; invalidated on hash change.
- **Cold-search tighten** â€” catalog `matchingKeys` filters then sorts and caches by `sort|filter|needle`.
- **UPG-002 synthetic 100k gate (software)** â€” Dexie **v15** `catalogKeys` multiEntry `*tokens` (unigrams + adjacent bigrams), flag indexes, persisted revision `count`, nearer-end deep page fetches, and multi-word bigram IDB lookup before `includes` filter. Same synthetic bench (`npm run benchmark:catalog`, `CATALOG_BENCH_SIZES=100000`). **100k before â†’ after (ms):** first-page reopen **372.7 â†’ 7.8**, cold search **1525 â†’ 118.1**, deep last-page jump **1139.6 â†’ 5.6**. All three under 200 ms on this machine. Real-device / disk-cold acceptance still separate. No SQLite.


Added for packaged stem supervise + export round-trip (still 0.3.2 software):

- **Packaged stem server root** - `electron/stemsService.cjs` resolves `MUSIC_EDITOR_SERVER_ROOT` / Choose server folder, then `resources/server` when packaged, then checkout `../server`. electron-builder `extraResources` copies server source + requirements + run scripts only (no venv, no torch/Demucs weights). Stems panel shows resolved path + missing-server errors. Default remains **no auto-start** on launch.
- **Export software round-trip tests** - `src/export/verifyParse.ts` + `roundTrip.test.ts` parse Rekordbox XML / M3U8 and assert BPM/key/cues/grid survive; review-gate skip stays consistent. Physical import into Rekordbox/Serato remains an acceptance gate.

## Long-file streaming (software Partial; physical acceptance Open)

Wired 2026-09-23. Defaults from `app/src/audio/decodePolicy.ts`:

- Stream when `durationSec > 15 min`, or estimated PCM `> 128MB`, or encoded `> 64MB`.
- **Inspector / main Player**: `shouldStream(track)` uses `player.loadStream(blob, durationHint)` (HTMLAudioElement + MediaElementSource). Full PCM is **not** stored in `decodedRef` for those tracks. UI shows a streaming note; beat click remains audition-only (as `player.ts` documents). Seek/cues/phrases use `player.seek` on the media clock.
- **Short files**: unchanged decode + `AudioBufferCache` (256MB LRU) path.
- **Mix Mode**: oversized tracks load via `Deck.loadStream` (HTMLAudioElement into the existing EQ/crossfade graph). Short tracks keep full-PCM Worklet + WSOLA. Streaming decks support play/pause/seek/EQ/crossfade/gain; WSOLA key-lock, beat loops, slip, and rolls are disabled with an explicit amber banner (`MIX_MODE_STREAM_LIMITS`). Tempo/phase sync on stream uses `playbackRate` + media-clock seek (not sample-accurate WSOLA). `mixModeUsesStream` chooses the path; `mixModeDecodeRefusal` now always returns null. No silent first-N-minutes decode.
- **Analysis**: `analysisDecodeRefusal` in `workerRunner` Ã¢â‚¬â€ fail the job with a clear decode error rather than OOM. No first-N-minutes partial analyze by default.
- **Not claimed done**: physical 1h/2h/3h RAM soak, device hotplug/sleep-wake soak. UPG-002 **synthetic** 100k gate met (see above); real-device 100k still Open. UPG-007 / Phase 3 remain **software Partial**; UPG-008 software hooks Partial (see below); multi-hour / physical device acceptance still **Open**.


## Device recovery (UPG-008 software Partial; physical acceptance Open)

Wired 2026-09-23. Shared helpers in `app/src/audio/devices.ts`:

- `watchOutputDevices` - listen for `devicechange`, re-enumerate outputs
- `recoverOutputSelection` - if selected sink is gone, fall back to system default with a clear status message
- `setAudioOutputDevice` / `supportsAudioOutputSelection` - shared `setSinkId` path used by Mix `Mixer` and inspector `Player`
- `attachAudioContextRecovery` - `statechange` + visibility/focus resume attempt when transport still wants to play

**Mix Mode:** controlled output select (includes System default); on device loss applies fallback + amber note; context recovery updates the same status line.

**Inspector:** App attaches context recovery to the main Player context; suspend/interrupt surfaces via `setNotice`.

Verify after UPG-002 catalog work: **434 tests / 48 files** green (lint + build + desktop/job/catalog smokes).

**Not claimed done:** physical USB/BT unplug while playing, Bluetooth drop, multi-hour sleep/wake soak. UPG-008 acceptance remains **Open**.

## Remaining work (not done here)

- Phrase estimation / HPSS / bass chroma / library energy / audition: **software landed this session** (heuristics; see below). Not labelled-corpus, EBU, or stem-quality certified.
- Packaged stem supervise: software path resolve + extraResources source ship done; system Python + pip still required; Demucs/torch weights never bundled; physical Demucs GPU/OOM remains Open
- Real-device 100k-track media/RAM acceptance (synthetic UPG-002 gate met); signed installers (Authenticode)
- Physical long-file (1h/2h/3h bounded-memory soak) / device hotplug/sleep-wake / Demucs GPU-OOM gates Ã¢â‚¬â€ inspector + Mix Mode streaming + UPG-008 software recovery hooks wired; physical soak still Open
- Installer upgrade/rollback on a real user profile

## UI modernize pass (software, 2026-09-24 evening)

Visible dark DJ / library redesign so `npm run desktop:dev` no longer looks like the old dense gray utility chrome. **Not acceptance / not phase complete.**

- Design tokens: layered `--bg` / `--shell` / `--panel*` / `--card`, brighter teal `--accent` (#22b8cf), soft accent fills, elevation shadows, larger radius scale.
- Product header (brand mark + gradient title), pill view tabs, pill Import/Add actions.
- Toolbar search as real pill search field; toolbar meta styling.
- Library pane with section head; selected/hover rows with accent inset + soft fill; track titles bolder.
- Inspector: facts/grid/export as elevated cards; uppercase tracked section labels; taller waveform chrome.
- Mastering panel: featured card (glow gradient, accent border, stronger title) — still monitor-only, Bypass default on.
- Mix Mode: same card/deck/crossfader tokens + larger Mix title.
- Light JSX only in `App.tsx` / `MixMode.tsx` / `LibraryList` row height 68; no DSP/workflow changes.
- Verify 2026-09-24 CT evening: **442 tests / 49 files**; lint + build + desktop/job/catalog smokes green.

Tip: close old Electron windows, then `cd F:\Dev_apps\Music_editor\app && npm run desktop:dev`.


## Software leftovers landed (still 0.3.2; heuristic, not certified)

- **Phrase estimation** - `dsp/phrase.ts`. 8/16/32-bar phrases on the **effective** grid (locked/manual BPM respected in the UI). Waveform `P#` labels + inspector list. Grid heuristic only; no labelled-corpus accuracy claim. `ANALYSIS_VERSION` is **5**.
- **HPSS + bass chroma** - median-filter HPSS on the key spectrogram (`dsp/hpss.ts`). Bass-weighted chroma from the harmonic residual is a **confidence aid** (`applyKeySupport`); it does not replace `detectKey` or a user key override. Not a stem separator.
- **Library energy renormalization** - `energy.rawScore` stored beside raw features; `libraryEnergyDisplay` maps the library percentile to a 0-10 display. Intra-track 1-10 level and raw features are not overwritten. Bar graph uses `barsFromGrid` on the effective grid.
- **Transition audition** - `analysis/audition.ts` builds ranking-to-preview payload (durations, effective BPM pair, short end-of-outgoing window). Inspector **Audition** loads Mix Mode decks, beat-syncs, starts a short overlap, and `logFeedback`s `played`. Mix Mode itself is not rewritten.

## Security / secrets note

Root `.env` may contain `ANTHROPIC_API_KEY`. That key is unrelated to the desktop app runtime and **should be rotated** if this tree was shared. Do not commit secrets; `.env` must stay gitignored.

## Schema

Highest Dexie version: **v15** (`catalogKeys` `*tokens` + review/failed/reviewed indexes on top of v14 playlists/peakPyramids). Analysis JSON `ANALYSIS_VERSION` is **5** (phrase / HPSS / rawScore fields; no Dexie bump for analysis).

## UI polish + monitoring master (software, 2026-09-24)

- **UI polish** â€” denser library rows / inspector padding; shared CSS variables (`--accent`, type scale, spacing); unified `.notice` banners (info/warn/alert) for library status, inspector streaming, and Mix Mode streaming; focus-visible on controls; panel-head chrome for settings-like panels. Not a design-system rewrite; Mix/Stems remain discoverable.
- **Mastering (monitor path)** â€” `audio/mastering.ts` helpers + `audio/masterBus.ts` Web Audio bus (input gain â†’ low/high shelves â†’ soft-clip â†’ ceiling limiter â†’ output gain â†’ AnalyserNode meters). Wired into inspector `Player` and Mix Mode `Mixer` master. `MasteringPanel` with bypass, meters, settings persisted as `music-editor.mastering` (default **bypassed**). Labelled monitoring master only â€” **not** album-master export and **not** EBU R128 certification. Export still uses the original file.
- **Tests** - `audio/mastering.test.ts` for DSP helpers / settings clamp / soft-clip / MasterBus apply. Verify 2026-09-24 CT: **442 tests / 49 files**; lint + build + desktop/job/catalog smokes green. EBU / labelled-corpus / Authenticode remain Open.


## Empty-library UX (2026-09-24 evening)

User feedback called the empty GUI the worst state: giant Mastering panel with no
selection, postage-stamp library drop box, junk-drawer toolbar, floating track
count, and a stacked Dexie `DatabaseClosedError` banner.

Changes (UI only — no DSP rewrite, no phase claim):

- **No selection:** full Mastering panel hidden; calm empty-state card + one-line
  “Select a track to monitor mastering” hint; Import / Add CTAs when library is empty.
- **Library empty:** centered empty state (“No tracks yet”) with Import folder / Add audio.
- **Toolbar:** two rows (search+filters / pagination+Add folder); Analysis timeout moved to Settings.
- **Track count:** muted text in Library pane head (not between brand and tabs).
- **Notices:** single `notice-stack`; `DatabaseClosedError` softened to a short human
  message + Dismiss; `db.open()` before liveQuery/scheduler; timeout no longer remounts scheduler.
- **Selected track:** Mastering stays under Play transport with `compact`.

Verify: lint + **442** tests / **49** files + build + desktop/job/catalog smokes green.
Tip: re-run `npm run desktop:dev` from `app/` to see the empty state.
