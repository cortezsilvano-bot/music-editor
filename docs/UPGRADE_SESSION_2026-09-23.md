# Upgrade implementation session - 0.3.0 through 0.3.2

Updated September 23, 2026. This records the changes made during the implementation session that began September 22, including the requested follow-up report note.

## Scope and status

Implemented the foundation upgrades, durable stem jobs and the paged-library continuation from the [supplied consolidated plan](CONSOLIDATED_UPGRADE_PLAN.md) in the existing application. This is **not a claim that the entire plan is complete**. The application, DSP algorithms, native tag writer, separation algorithms, mixer and existing user data were preserved. The stem service boundary was upgraded in the continuation described below.

The source was ahead of the earlier implementation report: a two-deck AudioWorklet mixer, WSOLA, stem UI/cache, native MP3/FLAC tag writing, transition feedback, and acoustic fingerprints already existed before this session. These are baseline capabilities, not changes attributed to this session. The initial automated baseline was **308 passing tests in 24 files**, with lint and production build passing.

## Changes implemented in this session

### Durable analysis jobs

- Replaced unconditional startup resets of running jobs with atomic IndexedDB claims, unique scheduler ownership, a unique token for each attempt, leases and heartbeats.
- Starting another window leaves live work alone. Expired work is recovered only after its lease expires. Every result commit checks the current owner, run, attempt and lease inside the same transaction as the result write.
- Cancellation persists across windows and reloads. The worker owner detects remote cancellation on its heartbeat and terminates its worker. Late results from cancelled or superseded attempts cannot overwrite current results.
- Added bounded automatic retries with exponential backoff for worker crashes, unreadable worker messages and timeouts. Invalid audio/ordinary analysis failures require explicit retry. Default maximum: three attempts per queued run.
- Added error codes, start/completion/update timestamps, heartbeat timestamps, stage/progress, retry scheduling and a persistent job-transition event log.
- Graceful scheduler disposal releases owned work; abrupt renderer failure is recovered through lease expiry. An explicit cancellation race also releases a hung runner that ignores its cancel callback.
- Added an analysis jobs panel showing status, progress, attempts, errors, cancel, retry and reanalysis. Added a persisted 2/5/15/30/60-minute timeout setting; UI default is five minutes.
- Separated live track and job subscriptions. Job heartbeats no longer reload every audio/analysis record, and changes in other windows update the UI.

Code: [scheduler](../app/src/analysis/scheduler.ts), [error classification](../app/src/analysis/jobErrors.ts), [worker runner](../app/src/analysis/workerRunner.ts), [jobs panel](../app/src/ui/JobsPanel.tsx), [application integration](../app/src/App.tsx).

### Additive storage migrations and analysis history

- Added schema v10 job metadata and the `jobEvents` table. Existing cancelled/completed states are retained; migrated interrupted jobs have no live owner and can be recovered normally.
- Added schema v11 `analysisHistory`. The v9-to-v11 upgrade does not rewrite track audio, peaks, tags, manual edits, cues, feedback or cached stems.
- Centralized automatic-result persistence in one transaction. It stores an immutable result snapshot, retains a pre-existing legacy result on the first subsequent save, and updates the current result and fingerprint together.
- Scheduler commits use the attempt token as snapshot identity, preventing duplicate result publication. A failed duplicate snapshot write rolls back the entire transaction.
- Automatic writes leave BPM/key/grid corrections, locked grids and cues untouched. Review acknowledgement clears when a new analysis is committed, as before.
- Track deletion now removes associated analysis jobs, job events and result history atomically. Existing stem-cache eviction behavior remains separate.
- Added an inspector history panel showing retained results, analyzer versions, parameter hashes and confidence. Legacy analysis dates are not invented: snapshot `savedAt` is the archival time, not the original analysis time.

Code: [database and persistence](../app/src/db/library.ts), [history panel](../app/src/ui/AnalysisHistory.tsx).

### Analyzer provenance and stale-result handling

- Added a registry for preprocessing, tempo, grid, key, loudness, energy, vocals, structure and fingerprint stages.
- New results record each stage's ID, version, parameters, deterministic parameter hash, completion timestamp, completed status and confidence where an estimate exists. Unavailable confidence remains `null`.
- Missing/changed provenance marks results stale; historical results are not backfilled with fabricated analyzer versions.
- Added a low-priority “Queue stale analyses” action and integrated provenance into review reasons. Existing results remain usable until the user queues replacement work.
- Kept the DSP algorithms and compatibility `ANALYSIS_VERSION = 4` unchanged. This session establishes the provenance baseline; it does not establish new musical-accuracy claims. Reanalysis still runs the full pipeline; stage-level feature caching is not implemented.

Code: [registry](../app/src/analysis/registry.ts), [pipeline](../app/src/analysis/pipeline.ts), [review](../app/src/db/review.ts).

### Library responsiveness and decoded-audio memory

- Extracted a memoized virtual library list. Large libraries render only visible rows plus overscan, with fixed 64-pixel rows, keyboard selection and list position metadata. Small libraries retain normal row rendering.
- Cached normalized search text, display names, effective BPM and review flags per database snapshot. Sorting is reused while typing instead of recomputed for every search.
- Removed redundant explicit full-library reads after edits/imports; the live database subscription supplies the update. Memoized stale counts and job labels to avoid full-library work on every playback animation tick.
- Replaced the unbounded decoded-buffer map with a 256 MiB least-recently-used PCM cache. Oversized buffers are not retained in the cache; active players keep their own references.
- Analysis can reuse decoded audio already in that cache. Worker messages receive copies, so transfer/mutation cannot detach or alter the buffer used for playback.
- Surfaced asynchronous audio-fingerprint and transport-start errors. A handled keyboard selection no longer also activates the global Space transport shortcut.

**Limit:** this bounds the shared cache, not total process memory. Import, analysis and active decks still decode full tracks and may hold additional PCM copies. Multi-hour bounded-memory streaming is not implemented.

Code: [query cache](../app/src/db/libraryQuery.ts), [virtual library](../app/src/ui/LibraryList.tsx), [PCM cache](../app/src/audio/bufferCache.ts).

### Regression tooling, exports and release metadata

- Added accessible labels for export folder/playlist fields. Fixed the desktop smoke test to select the export folder by its label; the old CSS selector picked a checkbox in the newer native tag-writing panel.
- Added a real Electron multi-window lifecycle test that forcefully crashes the renderer owning a job, verifies recovery in another renderer and confirms one result/history commit with manual edits preserved. It also tests remote cancellation and cancellation persistence after reload.
- Added repeatable Dexie and library-UI benchmarks in isolated temporary profiles and uniquely named databases. The benchmark deletes only its own generated database.
- Added `test:jobs`, `benchmark:library` and `verify` npm scripts. `verify` runs lint, unit/integration tests, production build, desktop workflow smoke and job lifecycle smoke.
- Bumped application/package-lock release metadata from 0.2.0 to 0.3.0. Packaging uses a separate `release/0.3.0` output, preserving the previous release artifacts.
- Preserved the supplied upgrade plan in this repository and linked this session report from the historical implementation report.

Tooling: [desktop smoke](../app/scripts/desktop-smoke.mjs), [job lifecycle](../app/scripts/job-lifecycle.mjs), [lifecycle fixture](../app/bench/job-lifecycle.ts), [Dexie benchmark](../app/scripts/library-benchmark.mjs), [query fixture](../app/bench/library-scale.ts), [UI benchmark](../app/scripts/library-ui-benchmark.mjs), [UI fixture](../app/bench/library-ui.tsx), [package scripts](../app/package.json).

### Previous 0.3.0 installer

Windows x64 NSIS packaging succeeded using `node node_modules/electron-builder/cli.js --win --config.directories.output=release/0.3.0` from `app/`.

- Artifact: [MusicEditor-Setup-0.3.0.exe](../app/release/0.3.0/MusicEditor-Setup-0.3.0.exe)
- Size: 112,100,768 bytes.
- SHA-256: `BA369D400C8BCCCB6ED4A7D4A4DFF2DCD566CEFD36874B0E20B32B98657CECAC`.
- Authenticode status: `NotSigned`.
- The installer was built, not installed over the user's application. Installed-profile upgrade/rollback remains an explicit acceptance gate below.

## Validation results

The initial 0.3.0 `npm run verify` passed (superseded by the continuation results below):

- **328 tests in 29 files**. New coverage includes competing claims, live/expired leases, late-result rejection, heartbeats, remote cancellation, retry bounds/backoff, permanent decode failures, migration preservation, immutable history, duplicate commit rollback, registry staleness, query semantics, cache eviction, transferable PCM isolation and virtual scrolling through 100,000 rows.
- ESLint: passed with zero warnings.
- TypeScript and Vite production build: passed.
- Desktop workflow smoke: passed. It imports a real generated WAV, compares persisted audio bytes/hash, reloads, plays audio, edits BPM without restarting the source, preserves cues, rejects an exact duplicate, exports XML containing corrected BPM/cues, and repairs a legacy analysis shape.
- Electron lifecycle smoke: passed. Live leases are not stolen; forcefully crashed renderer work is recovered; one result is committed; manual BPM/cues survive; cross-window cancellation survives reload.

Test changes: `analysis/scheduler.test.ts`, `analysis/scheduler.leases.test.ts`, `analysis/registry.test.ts`, `analysis/workerRunner.test.ts`, `db/migration.test.ts`, `db/library.test.ts`, `db/libraryQuery.test.ts`, `audio/bufferCache.test.ts`, `ui/LibraryList.test.tsx` under `app/src/`.

## Measured storage and UI results

Real Chromium IndexedDB, synthetic track records, 2,000-float peaks per track, analysis objects, metadata and 44-byte audio placeholders. These results do not measure real media import/analysis throughput. Query median/max-of-seven samples are recorded; the reported p95 is the maximum of seven samples, not a large-sample percentile estimate.

| Tracks | Original full-record load | Original name sort, reported p95 | Optimized first name sort | Optimized search, reported p95 | Optimized review filter, reported p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 2,111.6 ms | 21.8 ms | 12.4 ms | 3.8 ms | 2.7 ms |
| 50,000 | 10,858.8 ms | 115.9 ms | 64.9 ms | 14.8 ms | 13.4 ms |
| 100,000 | 22,553.0 ms | 474.2 ms | 142.0 ms | 37.1 ms | 29.5 ms |

At 100,000 tracks, query-key preparation took 98.7 ms and full-record loading on the second run still took 19,596.5 ms. Original/optimized measurements are separate runs; environment and memory pressure affect comparisons. The synthetic 100k waveform payload alone is 800 MB.

The actual React library component rendered 13 rows at the end of each 10k/50k/100k scrolling run and reached the final track. The final UI benchmark measures DOM commit/layout, with a deliberate 20 ms event-settling wait, **not physical input-to-paint latency**. An earlier frame-based run is retained separately: background Electron animation-frame throttling made those timings unsuitable for user-perceived latency claims.

Evidence: [original Dexie run](benchmarks/library-scale.json), [optimized query run](benchmarks/library-scale-optimized.json), [DOM/UI run](benchmarks/library-ui.json), [background-frame diagnostic](benchmarks/library-ui-background-frames.json).

**Decision:** keep Dexie for this release. The optimized tested interactive queries meet the 200 ms target, but the overall 100k library gate is **not complete**. Full-record hydration remains unacceptable at that scale. The 0.3.2 continuation below implements a lightweight paged metadata repository/index with lazy detail loading. Compare SQLite if the remaining measured workloads still justify it. No database-engine migration was performed or silently declared unnecessary.

## A–N upgrade audit after this session

| Phase | Action | Current evidence and remaining work |
| --- | --- | --- |
| A Foundations | Preserve + harden | Additive migrations, regression command, desktop recovery checks and 0.3.0 build. Installed-release upgrade/rollback and broader shutdown scenarios remain unverified. |
| B Library/playback/waveform | Tune + extend | Virtual rows, query keys and bounded inactive PCM cache added. Paged metadata and lazy full-track loading added in 0.3.2. Long-file streaming, waveform levels and physical device recovery remain. |
| C Shared preprocessing/cache | Harden + consolidate | Cached playback PCM can feed analysis; provenance records configuration. No persistent intermediate-feature cache or Python/JS decode consolidation yet. |
| D Tempo/beats/grid | Preserve + validate | Existing tests/manual grids/locks retained and reanalysis protection tested. Labeled music corpus and timing-accuracy acceptance remain. |
| E Key/harmony | Preserve + validate | Existing profiles, tuning, key overrides and labels retained; versions recorded. External corpus accuracy and modulation work remain. |
| F Loudness/energy | Validate + harden | Existing DSP tests preserved; provenance added. No new EBU/ITU reference-vector certification claim. |
| G Metadata/export | Preserve + harden | Existing native safe writer and format tests preserved; export smoke fixed and passed. External DJ-software import round trip and durable export/write audit still remain. |
| H Structure/vocals/cues | Preserve + extend | Existing suggestions/cues preserved; reanalysis leaves cues alone. Structure validation and richer section corrections remain. |
| I Confidence/review | Extend | Stale analyzer detection/history added to current review workflow. Unified issue categories and ignore/resolution workflow remain. |
| J Jobs | Harden | Durable analysis ownership, recovery, cancellation, retries/events implemented and tested. Stem jobs now share the scheduler; see the 0.3.1 continuation below. |
| K Two decks | Preserve + extend | Existing AudioWorklet/WSOLA mixer retained with tests. Streaming, physical output recovery and longer synchronization acceptance remain. |
| L Recommendations | Preserve + validate | Existing score-derived explanations and feedback preserved with tests. No new ranking features in this session. |
| M Stems/mashup | Harden service + integrate | Durable scheduling, server cancellation/recovery, offline cache, and source/model/checkpoint identity implemented. Physical Demucs/GPU/OOM validation and synchronized mashup playback remain. |
| N Duplicates | Preserve + extend | Existing SHA-256/audio hashes/fingerprints preserved; result commit now keeps the stored fingerprint in sync. Relocation workflow and broader acoustic corpus validation remain. |

## Remaining acceptance gates

1. Paged lightweight library reads are implemented in the 0.3.2 continuation. Realistic media/throughput/RAM measurements, cold global search and whole-library auxiliary workloads remain to assess. Synthetic query success does not prove 100k end-to-end readiness.
2. Streaming decoder/transport work and 1h/2h/3h playback, seek/loop, device hotplug and sleep/wake testing. Current stereo float PCM alone is approximately 1.27 GB/hour at 44.1 kHz, before copies; this is a calculation, not a measured long-file test.
3. Unified review workflow, multi-resolution waveform cache, native write/export audit, and round-trip checks in target DJ applications.
4. Physical Demucs/GPU/OOM and synchronized mashup validation. Common durable stem jobs and a cancellable/recoverable service boundary are now implemented. The legacy blocking endpoint remains only for old clients. Model/library replacement still requires license and quality checks.
5. Labeled DSP reference corpus and trusted loudness vectors. Synthetic tests do not establish general music accuracy.
6. Installed 0.2.0 → 0.3.0 upgrade and rollback testing in an isolated Windows environment. Schema upgrade tests and installer generation are distinct from this gate; opening a migrated profile with an older app has not been established as safe.

No legacy user library was deleted, converted to SQLite or used as a benchmark dataset. No new DSP/model dependency was selected. No claim of complete A–N delivery or full plan acceptance is made.


## Continuation: durable stems - 0.3.1

The user asked why the remaining implementation had been left unfinished. The first stopping point was premature; development continued with the common stem-job workflow. This section records every additional change, without attributing pre-existing separation algorithms to this session.

### Shared app scheduler and migration

- Added `phase=stems`, separate track identity, persisted separation options and pending remote-cancellation state to the existing jobs model. Analysis and stem jobs use the same claim/lease/heartbeat/retry/event mechanism and background-jobs UI. Analysis and stems for a track have separate job IDs.
- Added additive IndexedDB schema v12. Existing v11 running-job ownership and leases are preserved while the track ID is populated. A migration regression test verifies this.
- Stem runs retain their server request ID across automatic retries and renderer recovery. Reconnecting first queries that ID; it does not upload and recompute an already completed remote result.
- Explicit cancellation persists a pending server acknowledgement. An offline cancellation is retried after service return/restart; delayed uploads cannot revive cancelled work. Merely leaving the panel or closing/reloading the app detaches the client without cancelling useful server work.
- Stem results are committed only while the attempt still owns its lease, in the same transaction as job completion. They never overwrite automatic analysis, manual edits or analysis-error status.
- Cache commits respect existing pins and the 2 GiB app cache cap. They atomically evict eligible old entries or fail visibly without destroying pinned data. Track deletion reports an error while active jobs or pending remote cancellation still need that track.
- Connection/download failures are classified for retry. Stem processing has its own one-hour attempt timeout. Stage labels replace invented percentage progress for long service work.

Code: [common scheduler](../app/src/analysis/scheduler.ts), [database](../app/src/db/library.ts), [stem runner/client](../app/src/stems/jobs.ts), [service types](../app/src/stems/service.ts), [stem cache](../app/src/db/stems.ts), [background jobs](../app/src/ui/JobsPanel.tsx), [App wiring](../app/src/App.tsx), [error codes](../app/src/analysis/jobErrors.ts).

### Supervised Python execution

- Added protocol v2: idempotent `PUT`, status/result `GET`, and cancellation `DELETE` at `/api/studio/jobs/{runId}`. Health advertises the protocol; the UI requests a restart if it finds the old service.
- Added a small SQLite execution journal inside the service's existing jobs directory. This is remote execution state keyed by the app's run ID, **not a migration of the music library from Dexie**.
- Atomic server claims allow one expensive separator per execution journal, including across multiple service instances. Ownership, attempt tokens, leases, three-attempt interruption limits and a one-hour compute deadline bound work.
- Each attempt runs the existing DSP or Demucs separator in a child process. Cancellation terminates computation. A child watchdog exits if its supervisor disappears, cancellation is recorded or its lease/token is lost; it never terminates an unrelated PID.
- Recovery reclaims expired work. Old attempts cannot publish results after ownership changes. Completed manifests are retained across service restarts; incomplete outputs are not downloadable.
- WAV outputs and final manifests use temporary files, filesystem flushes and atomic replacement. Downloads allow only completed manifest-listed stem filenames and exclude source audio.
- The legacy synchronous endpoint remains compatible. Its upload size is checked with a bounded read, its old cleanup skips the new durable directory, and its download containment check was tightened.
- Added seven-day server-file retention, configurable using `STEM_RESULTS_TTL_SECONDS` with a 60-second minimum. Cleanup checks the resolved directory is directly under the jobs root. It removes only terminal-job files, retaining IDs and cancellation tombstones. Cached app results are unaffected.
- Results include original-source SHA-256, model ID/version, implementation hash, Demucs checkpoint-tensor hash, actual device and an explicit CPU-fallback reason. The existing CPU fallback is preserved and made traceable. No replacement model or DSP library was selected.

Code: [API](../server/app.py), [supervisor/journal](../server/stem_jobs.py), [worker](../server/stem_worker.py), [fallback reporting](../server/demucs_separator.py), [service instructions](../server/README.md).

### Stem UI and cache behavior

- Replaced panel-local request ownership with durable job subscriptions. Switching tracks/unmounting the panel no longer loses task state.
- Cached results are listed and playable even when Python is offline. Multiple cached variants can be selected; legacy entries remain readable.
- New cache identity includes source hash, model/version, checkpoint/implementation hashes, quality and stem layout. Results with another known source hash are rejected/filtered instead of silently reused.
- Added per-stem mute, solo and volume controls alongside playback and download. These are independent HTML-audio previews, not a claim of sample-synchronized multi-stem mashup transport.
- Object URLs are created and revoked on component lifecycle boundaries, fixing the previous per-render URL leak. Pin/delete/clear-unkept controls remain available offline.
- Source-hash mismatch, service version mismatch, failure, waiting-for-cancellation and CPU-fallback information are surfaced in the UI.

Code: [StemsPanel](../app/src/ui/StemsPanel.tsx).

### Continuation validation

`npm run verify:stems` passed in the current workspace:

- **337 app tests in 31 files**, plus lint and production build.
- **12 Python service tests**, including real DSP output, source hash and WAV dimensions; idempotent submissions; cancellation before upload; termination of a real child; expired-lease recovery and old-result fencing; invalid audio; missing manifests/partial results; compute deadline; orphan watchdog exit; safe terminal-file retention; HTTP status/download contract and path rejection.
- Existing Electron import/playback/grid/cue/export/duplicate smoke: passed.
- Existing Electron multi-window analysis crash/cancellation smoke: passed.
- New Electron-to-Python stems smoke: passed using an isolated service port, journal and app profile. It queues actual DSP separation through the common scheduler, checks the original-file SHA-256, caches four stems, verifies solo mutes the other three, stops Python, reloads the app and renders cached audio controls without recomputation. The test checks the cached audio controls; it does not measure audible output or stem quality.

New tests: [scheduler stems](../app/src/analysis/scheduler.stems.test.ts), [remote client](../app/src/stems/jobs.test.ts), [v11 migration](../app/src/db/migration.test.ts), [Python lifecycle](../server/test_stem_jobs.py), [HTTP contract](../server/test_stem_api.py), [desktop stems smoke](../app/scripts/stems-smoke.mjs).

Added npm commands: `test:server`, `test:stems`, `verify:stems`. Package and lockfile metadata are now 0.3.1. The Python service remains separate, as before; restart it from the updated `server/` source to enable protocol v2. The installer does not bundle Python/PyTorch.

Physical GPU/OOM testing, learned-model audio quality, multi-stem synchronized playback and the other outstanding upgrade gates above are not marked complete by these tests.

### Built 0.3.1 installer

Windows x64 NSIS build succeeded in the separate `release/0.3.1` directory:

- [MusicEditor-Setup-0.3.1.exe](../app/release/0.3.1/MusicEditor-Setup-0.3.1.exe), 112,108,515 bytes.
- SHA-256: `1BD2A6D3D0061C23433A9B74888EE4B0DA5B13B03B34D6B8D48E85FDDCDD6733`.
- Authenticode status: `NotSigned`.
- Prior installers remain available. This installer was generated but not installed over the user's application; the separate installed-upgrade/rollback gate remains open.


## Continuation: paged library and lazy track details - 0.3.2

### Changes implemented

- Added additive Dexie schema v13 with separate metadata, compact search keys and indexing/checkpoint state. Original audio, waveforms, full analysis, manual edits, cues, job history and stems stay in their existing stores.
- Track writes update metadata and search keys in the same native IndexedDB transaction. This covers normal adds/updates, analysis completion, collection modifications, partial bulk failures, range deletion and clearing. Projection failures abort the original write. A persisted revision invalidates cached queries across app windows.
- Existing libraries build the new index in bounded 100-track transactions. Checkpoints survive closing/reopening; edits, deletion and insertion during indexing remain consistent. The index version includes analyzer configuration so a future configuration change rebuilds review/stale flags. Progress and indexing errors appear in the UI. This one-time backfill still reads every old full track; later library starts do not.
- The library reads 100 metadata records per page. Previous/Next controls, global title/artist/album/filename search, review filters, locale-aware name sorting, BPM sorting, selection and accessibility positions remain available. Page/search changes reset list scroll. Compact search keys and sort orders are cached; cached counts and compound-index cursors speed sequential page navigation.
- The selected inspector subscribes to one full track. Playback continues using the existing bounded decode cache and only reloads audio on selection changes. Manual edits and new analysis update both details and library rows without resetting playback.
- Recommendations, export and Mix/Duplicates views load lightweight metadata when needed. Exports include the entire filtered result across pages and wait for completed indexing; they never silently export only the current page. Background-job names read only the displayed jobs' metadata.
- Mix selectors now provide search and at most 100 matching options. Loading a deck fetches the canonical full track before decoding, preserving current manual grids. Loading failures are surfaced.
- Duplicate review reads fingerprints only after Scan, fetching full source records in batches of 50 and retaining only fingerprints. Scan state resets when the library changes; scan and removal errors are visible. The pre-existing pairwise similarity algorithm is unchanged.
- Added repository consistency/migration/cache tests, an Electron pagination/search/edit/export/Mix smoke and an isolated 10k/50k/100k Chromium benchmark. Added `test:catalog` and `benchmark:catalog`; the catalog smoke is included in `verify`. Package/lock metadata are 0.3.2.

Code: [catalog repository and atomic projection](../app/src/db/catalog.ts), [database/schema](../app/src/db/library.ts), [shared tempo value](../app/src/db/trackValues.ts), [catalog/detail subscriptions](../app/src/ui/useCatalog.ts), [App](../app/src/App.tsx), [library rows](../app/src/ui/LibraryList.tsx), [export](../app/src/ui/ExportPanel.tsx), [Mix](../app/src/ui/MixMode.tsx), [duplicates](../app/src/ui/DuplicatesPanel.tsx), [job names](../app/src/ui/JobsPanel.tsx), [metadata recommendations](../app/src/analysis/recommendations.ts).

### Validation and measurements

`npm run verify:stems` passed after the final code changes:

- **345 app tests in 32 files**, plus lint and production build.
- **12 Python service tests**.
- Existing desktop import/playback/grid/cue/export/duplicate-import smoke: passed.
- Existing multi-window job lease/crash/recovery/cancellation smoke: passed.
- New catalog smoke: passed with 205 tracks, three pages, global search for a track outside the current page, a BPM edit reflected in the catalog, an XML export containing all 205 matches and a searched deck load retaining the edited 123 BPM grid.
- Existing real-DSP stems/cached-offline playback-controls smoke: passed.

The new UI test exposed a real `PrematureCommitError` on cached search changes immediately following an edit. Repository reads now retain Dexie's promise chain on cache hits; the regression scenario passes in Chromium. The complete verification run passed after this fix.

Tests: [repository](../app/src/db/catalog.test.ts), [catalog desktop smoke](../app/scripts/catalog-smoke.mjs). Benchmark: [workload](../app/bench/library-catalog.ts), [runner](../app/scripts/catalog-benchmark.mjs).

### Final catalog benchmark

Final results are saved in [library-catalog.json](benchmarks/library-catalog.json). The earlier exploratory run is retained in [library-catalog-initial.json](benchmarks/library-catalog-initial.json); it predates the final cached-count/cursor and transaction-lifetime fixes and is not the release measurement.

| Tracks | One-time index build | First 100 rows after DB reopen | Next page | Cold global search/name sort | Warm search p95 | Warm BPM page p95 |
|---:|---:|---:|---:|---:|---:|---:|
| 10,000 | 3.59 s | 21.8 ms | 5.6 ms | 138.8 ms | 4.3 ms | 6.4 ms |
| 50,000 | 25.24 s | 114.3 ms | 6.2 ms | 611.8 ms | 12.2 ms | 21.3 ms |
| 100,000 | 51.13 s | 372.7 ms | 7.9 ms | 1525.0 ms | 29.0 ms | 7.4 ms |

- **Zero full-track reads** for the measured library queries at all three sizes. A separate single-record detail fetch made one canonical read (0.7 ms at 100k). This counts repository operations, not every independent inspector/playback subscription in the app.
- At 100k, the first page contains 100 metadata records, approximately 86.6 kB serialized as JSON. Waveforms, original audio, fingerprints and analysis curves are excluded; grids and cues remain variable-size metadata.
- At 100k, warm review-filter p95 was 21.6 ms and warm name-page p95 was 46.9 ms. Sequential paging uses compound-index boundaries. An uncached direct jump to the last page still took 1,139.6 ms.
- The prior benchmark loaded all 100k full records in 19,596.5 ms. The new measurement reads only the first 100 metadata records; these are deliberately different startup workloads, not equivalent all-record queries.
- **The complete 100k performance gate remains open.** Warm queries and sequential navigation are under 200 ms here; reopened first-page loading (372.7 ms), cold global search (1,525.0 ms) and an uncached deep jump exceed it. The one-time legacy backfill took 51.13 seconds, with visible progress and resumable checkpoints.
- Measurements use real Chromium IndexedDB with synthetic analysis, 2,000-float peaks and 44-byte audio placeholders. Seven warm samples are reported; p95 is the maximum of seven. These numbers exclude real-media decoding, React paint, physical audio and an OS disk-cold cache guarantee. Final benchmarking ran after builds/tests had finished.

### Limits still open

The new index consumes additional disk space. Global search/name sorting initially loads compact keys for the whole library; export, recommendations and auxiliary views can still load all lightweight metadata. Duplicate similarity remains pairwise and is not certified for 100k tracks. Raw IndexedDB writes made outside the application's Dexie middleware bypass index maintenance. Synthetic reads do not certify real media throughput, maximum RAM, perceived frame latency or physical audio playback. No SQLite migration or claim of complete A-N delivery is made. Other remaining acceptance gates above remain open.


### Built 0.3.2 installer

Windows x64 NSIS packaging succeeded in the separate `release/0.3.2` directory:

- [MusicEditor-Setup-0.3.2.exe](../app/release/0.3.2/MusicEditor-Setup-0.3.2.exe), 112,117,989 bytes.
- SHA-256: `B583BECF6476432B7A623E4FC632D80DDC96053567CC9A3F2C5702118E590D7E`.
- Authenticode status: `NotSigned`.
- The existing installers remain available. The new installer has not been installed over the user's application. Installed upgrade/rollback testing remains a separate acceptance gate.
