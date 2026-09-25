# Consolidated Upgrade Development Plan

## Existing Application â€” Preserve, Harden, Extend

This project is an **incremental upgrade of an existing music-analysis / DJ desktop application**, not a greenfield rewrite.

The upgrade strategy is:

**VERIFY â†’ PRESERVE â†’ HARDEN â†’ EXTEND â†’ MIGRATE ONLY WHEN JUSTIFIED**

The existing application already reports substantial functionality across library management, analysis, playback, cues, exports, jobs, recommendations and duplicate detection. The goal is therefore to strengthen its foundations and add missing advanced capabilities without unnecessarily replacing working functionality.

---

# 1. Current Application Baseline

Based on the supplied project documents, the current application is reported to use:

* Electron desktop shell
* React UI
* Web Audio
* Web Workers
* IndexedDB / Dexie
* Python service for heavier DSP / stem separation
* Windows packaging / NSIS

The supplied architecture assessment considers Electron + React + Web Audio a reasonable existing foundation, while identifying potential scale, job-management and multi-deck limitations that should be measured before changing architecture.

## Reported Existing Capabilities

### Library

Reported:

* File import
* Folder import
* Metadata reading
* Search
* Sorting
* Filtering
* Existing library persistence

### Playback

Reported:

* Web Audio playback
* Waveform display or waveform-related UI
* Seeking/playback controls

Long-file streaming and two-deck readiness remain areas to verify.

### Tempo / Beat Grid

Reported:

* BPM detection
* Beat grid
* Manual tempo correction
* Grid locking

### Key / Harmony

Reported:

* Musical-key analysis
* Key correction
* Reference tones/chords

### Loudness / Energy

Reported:

* Loudness
* True peak
* Energy
* Per-bar energy

### Cues / Structure

Reported:

* Persistent cues
* Heuristic section suggestions

### Review

Reported:

* Review flags
* Explanations for uncertain results

### Jobs

Reported:

* Persistent analysis jobs
* Cancellation
* Timeout
* Recovery
* Manual retry

### Recommendations

Reported:

* Basic explained next-track recommendations

### Duplicate Detection

Reported:

* SHA-256 exact duplicate rejection

### Stems

Reported:

* Python stem-separation service exists
* Full application-facing stem/mashup workflow is not complete

### Two-Deck Mixing

Reported:

* Not implemented

The two-deck and stem states are materially different: two-deck is a new feature, whereas stems appear to have an existing backend foundation that should be integrated rather than rebuilt.

---

# 2. Core Upgrade Rules

## Rule 1 â€” Preserve Existing Functionality

Do not replace a component merely because another architecture is theoretically better.

Existing behavior should remain unless:

* It fails agreed benchmarks
* It causes correctness problems
* It presents a security or data-loss issue
* It prevents a required new feature

## Rule 2 â€” Regression Protection Is Mandatory

Every milestone has two gates:

### New Capability Gate

The upgrade works.

### Regression Gate

Previously working behavior still works.

A milestone is not complete if the new feature works but breaks an existing workflow.

## Rule 3 â€” User Data Is More Important Than Infrastructure Elegance

Protect:

* Imported tracks
* Metadata
* BPM corrections
* Beat-grid corrections
* Key corrections
* Cue points
* Section corrections
* Ratings
* Flags
* Analysis history
* Stem results
* Export configuration

## Rule 4 â€” Prefer Additive Migrations

Use:

**old implementation â†’ compatibility layer â†’ upgraded implementation â†’ parity validation â†’ controlled switch**

Do not use:

**delete old implementation â†’ rebuild everything â†’ attempt recovery**

## Rule 5 â€” New Features Reuse Existing Data

Two-deck mixing should consume the application's existing:

* BPM
* Grid
* Downbeats
* Key
* Cues
* Waveform
* Track metadata

Do not create a second independent BPM/grid system specifically for the mixer.

---

# 3. Phase 0 â€” Code Audit + Upgrade Delta

The first development activity is to determine what actually needs upgrading.

For every Aâ€“N subsystem classify the implementation as:

| State    | Meaning                                                          |
| -------- | ---------------------------------------------------------------- |
| Preserve | Existing implementation already meets requirements               |
| Tune     | Minor optimization/configuration                                 |
| Harden   | Existing implementation needs reliability improvements           |
| Refactor | Internal changes required while preserving behavior              |
| Extend   | Existing system needs additional capability                      |
| Replace  | Existing implementation demonstrably cannot satisfy requirements |
| New      | Feature does not currently exist                                 |
| Verify   | Insufficient evidence                                            |

## Aâ€“N Upgrade Matrix

### A. Foundations

Likely action:

**Preserve + Harden**

Verify:

* Electron build
* NSIS
* CI
* smoke test
* logging
* update path
* migrations
* shutdown lifecycle

### B. Library / Playback / Waveform

Likely action:

**Preserve UI + Benchmark Engine + Extend**

Do not replace playback until profiling shows the current mechanism prevents:

* long files
* tight looping
* streaming
* two decks

### C. Shared Preprocessing / Cache

Likely action:

**Harden / Consolidate**

The documents identify possible duplicated decoding and preprocessing between JS workers and Python. Cache entries should eventually be associated with track, feature, analyzer version and parameter hash.

### D. Tempo / Beats / Grid

Likely action:

**Preserve + Validate**

Existing manual corrections and grid locks are valuable.

Upgrade correctness without discarding the workflow.

### E. Key / Harmony

Likely action:

**Preserve + Validate + Extend**

Potential later additions:

* Camelot/Open Key presentation
* relative-key relationships
* harmonic recommendations
* modulation/section-level analysis

### F. Loudness / Energy

Likely action:

**Validate + Harden**

Verify actual R128 / BS.1770 behavior before replacing anything.

### G. Metadata / Export

Likely action:

**Preserve + Harden**

### H. Structure / Vocals / Cues

Likely action:

**Preserve cues + improve suggestions**

### I. Confidence / Review

Likely action:

**Extend**

Create a unified review workflow.

### J. Job Scheduling

Likely action:

**Harden**

Existing scheduling should be reused if it can support leases, ownership and recovery.

### K. Two-Deck

Action:

**New capability**

### L. Recommendations

Likely action:

**Extend existing capability**

### M. Stems / Mashup

Action:

**Integrate existing backend + extend UI**

### N. Duplicate Detection

Likely action:

**Preserve SHA-256 + extend with acoustic matching**

---

# 4. Regression Baseline Before Major Changes

Before architecture changes, create an automated baseline.

Measure:

* Existing tests
* Import success
* Search behavior
* Playback
* BPM analysis
* Grid correction
* Key correction
* Loudness analysis
* Cues
* Exports
* Job cancellation
* Crash recovery
* Recommendations
* Duplicate rejection

Create test libraries at:

* 10,000 tracks
* 50,000 tracks
* 100,000 tracks

Measure:

* Startup time
* Initial library display
* Search latency
* Filter latency
* Sort latency
* Scroll performance
* Import throughput
* Analysis throughput
* RAM consumption

The source specifically calls for 10k/50k/100k scale testing rather than assuming the current database is inadequate.

---

# 5. Storage Upgrade â€” Conditional, Not Automatic

The source recommends SQLite for a 100k+ track target, but because this is an existing application, migration should occur only after benchmarking the current Dexie implementation.

## Decision Gate

Test IndexedDB/Dexie with realistic queries.

Target typical search/filter latency:

**<200 ms**

If it passes reliably:

**keep it and harden it.**

If it fails:

introduce SQLite incrementally.

## Target SQLite Architecture

Electron main owns the database.

Renderer accesses it through typed repository APIs such as:

* `getTracks`
* `getTrack`
* `searchTracks`
* `updateTrack`
* `saveCue`
* `enqueueJob`

Renderer should never receive unrestricted SQL access.

---

# 6. Upgraded Data Model

If migration is required, preserve the source document's separation between automatic data and user changes.

## tracks

Core library identity and metadata.

Suggested:

* id
* path
* sha256
* size
* mtime
* duration
* sample_rate
* channels
* artist
* title
* album
* rating
* flags
* timestamps

## analysis_results

* track_id
* algo_id
* algo_version
* params_hash
* result/payload
* confidence
* status
* timestamps
* error

## user_edits

Separate manual changes from machine analysis.

Examples:

* BPM override
* key override
* grid adjustment
* downbeat
* cue
* section correction

### Critical rule

**User edits always override automatic results.**

The source explicitly recommends separate algorithm/version records plus user overrides rather than letting automatic re-analysis silently overwrite corrections.

## jobs

Suggested:

* job_id
* track_id
* phase
* status
* owner
* priority
* attempts
* max_attempts
* created_at
* updated_at
* last_heartbeat_at
* error_code
* payload

## cues

* track_id
* cue_id
* type
* position
* label
* locked

## stems

* track_id
* stem_type
* file_path
* model_id
* model_version
* created_at

## exports

Track export history for audit and troubleshooting.

---

# 7. Milestone 1 â€” Harden Storage, Jobs and Upgrade Safety

## Do First

This milestone affects everything else.

### Job Improvements

Keep the existing scheduling implementation where possible, but add:

* Atomic ownership
* Lease
* Heartbeat
* Retry limit
* Retry classification
* Cancellation
* Crash recovery
* Idempotency
* Error codes
* Persistent status

### Required behavior

Kill application during analysis.

Restart.

Expected:

* No zombie jobs
* No duplicate jobs
* Running work is recovered or safely failed
* Retry works
* Cancellation remains respected

The source proposes the same persisted job model and explicitly calls for atomic claiming plus heartbeat detection of zombie jobs.

## User-visible statuses

* Queued
* Processing
* Completed
* Failed
* Cancelled
* Retry available

## Estimated Work

Existing document estimate for job-queue hardening:

**3â€“7 developer-days**, highly dependent on the current implementation.

---

# 8. Milestone 2 â€” Analysis Versioning and Correctness

Do not automatically replace the analysis algorithms.

Benchmark current implementation first.

## Every Analyzer Must Expose

* Name
* Version
* Parameter hash
* Confidence
* Result
* Timestamp

## Version Example

`tempo:v2.1.0`

## Upgrade Behavior

When analyzer version changes:

* Previous result remains traceable
* Track can be marked stale
* User can re-analyze
* Manual correction remains authoritative

Possible UI:

**Analysis updated â€” 1,426 tracks have results from an older tempo analyzer.**

Actions:

* Analyze now
* Analyze when idle
* Keep current results

## Estimate

Source work-package estimate:

**5â€“10 developer-days** for versioning, migration, override behavior and associated UI, assuming the underlying analyzer architecture already exists.

---

# 9. DSP Validation

## BPM / Beats

Use a labeled test set.

The source proposes establishing an agreed accuracy target rather than asserting an arbitrary number; it gives â‰¥80% within a 4% tolerance as an example for general libraries.

Also measure beat-position timing.

Suggested engineering target:

approximately **Â±15 ms** on the selected reference corpus.

## Key

Measure:

* exact match
* musically related match such as Â±1 fifth

Manual override must propagate everywhere.

## Loudness

Validate against:

* EBU test vectors
* ITU test vectors
* trusted reference implementation

If the application claims true peak, verify proper oversampling.

The source calls for EBU R128 / ITU-R BS.1770 behavior and at least 4Ã— oversampling for true peak.

## Structure

Keep structure output labeled as a suggestion unless validated sufficiently.

---

# 10. Milestone 3 â€” Playback Engine Upgrade

The existing UI should remain.

Upgrade the internals only where required.

## Current Risk To Verify

If playback uses full-track `decodeAudioData()`:

* Multi-hour files consume excessive memory
* Multiple decks multiply that cost
* Streaming becomes difficult

## Target Architecture

**disk â†’ FFmpeg decoder â†’ PCM â†’ ring buffer â†’ AudioWorklet â†’ output**

Main:

* File access
* Decode
* Resample if necessary

Renderer:

* AudioWorklet
* Position
* Rate
* Gain
* Transport timing
* Mixer

The supplied architecture describes this main/renderer split and recommends cached downsampled waveform peaks.

## Preserve

Keep existing:

* play button
* seek UI
* waveform UI
* track-loading workflow
* hotkeys where applicable

Only change their backend.

## Required Scenarios

Test:

* 2-hour track
* 3-hour track
* repeated seeking
* rapid loop toggle
* output-device switch
* sleep/wake
* missing file
* decoder failure

Target perceived seek/loop response:

**<50 ms**

The supplied acceptance criteria use that latency class and explicitly require long-file and device-change handling.

## Estimated Work

Streaming playback work-package estimate:

**10â€“20 developer-days**, depending on how much of the current audio engine can be reused.

---

# 11. Waveform Upgrade

Do not decode audio whenever users zoom.

Generate reusable peak levels.

For example:

* Overview
* medium resolution
* bar-level
* detailed zoom

Cache peaks by:

`track hash + peak algorithm version`

This makes waveform navigation independent of full PCM memory.

---

# 12. Milestone 4 â€” Confidence + Review Workflow

Create a central:

# Review Needed

Possible reasons:

* BPM uncertain
* Half/double BPM ambiguity
* Key uncertain
* Downbeat uncertain
* Structure uncertain
* Missing media
* Suspected duplicate
* Failed analysis
* Failed metadata write

Actions:

* Accept
* Edit
* Lock
* Re-run
* Ignore

Filters:

* Tempo
* Key
* Structure
* Loudness
* Stems
* Duplicate

The supplied work package estimates approximately **5â€“10 developer-days** for confidence/review functionality if analyzers already expose the necessary diagnostics.

---

# 13. Metadata and Export Hardening

Preserve existing Rekordbox XML / M3U8 workflows.

## If Writing Audio Tags

Use:

**backup â†’ temporary file â†’ write â†’ fsync â†’ verify â†’ atomic replace**

Do not overwrite the only original copy directly.

Maintain:

* write timestamp
* app version
* operation status
* failure reason

The source explicitly calls for backup/atomic replacement and round-trip verification for file-writing operations.

## Export Regression Test

Set manually:

* BPM
* Grid
* Key
* Cues

Then:

**export â†’ import into target DJ software â†’ compare**

The values in:

* UI
* playback
* export

must come from the **same corrected source of truth**.

---

# 14. Milestone 5A â€” Integrate Existing Stem Service

Do not rebuild the stem engine merely to integrate it.

The existing Python service should become another consumer of the common job system.

## Workflow

Track

â†’ Separate Stems

â†’ enqueue `phase='stems'`

â†’ Python service

â†’ progress

â†’ output files

â†’ register results

â†’ playback

## Initial UI

Per stem:

* Vocals
* Drums
* Bass
* Other

Controls:

* Mute
* Solo
* Volume

## Store

* Model ID
* Model version
* model/checkpoint hash
* source track hash
* paths
* status
* creation date

## Recovery

Test:

* Cancel
* Kill Python service
* GPU out-of-memory
* CPU fallback
* App restart
* Partial files
* Reopen completed track

The source specifically requires completed stems to be discovered again without unnecessary reruns and calls for clear CPU/GPU fallback behavior.

---

# 15. Milestone 5B â€” Two-Deck Mixing

This is a new feature built on top of the upgraded playback engine.

## Deck A / B

Each deck:

* Load
* Play
* Pause
* Cue
* Nudge
* Seek
* Tempo
* Pitch
* Gain
* Loop
* Quantize

## Mixer

* Crossfader
* Deck gains
* Basic EQ/filter
* Master level
* Monitoring master (software, 2026-09-24): live MasterBus on Player + Mix — gain/EQ shelves/soft-clip/ceiling/meters/bypass; monitor path only; EBU cert still Open

## Clock

One shared transport clock.

Existing track grids become input to that clock.

## Quantization

Use existing:

* BPM
* Beats
* Downbeats
* Grid corrections

Manual corrected grids must be respected.

## Audio Routing

Where supported:

* Master output
* Cue/headphone output

## Acceptance

* Two simultaneous tracks
* Independent transport
* Crossfader without audible clicks
* Quantized loops
* Quantized cues
* Stable synchronization

These are directly aligned with the source's two-deck acceptance criteria.

## Estimated Work

Existing work-package estimate:

**10â€“20 developer-days** for the initial foundation after streaming playback exists.

---

# 16. Time-Stretch / Pitch-Shift Decision

Do not choose a library simply because it was listed in research.

Create a controlled comparison covering:

* Quality
* CPU
* Latency
* Tempo range
* Pitch preservation
* Windows packaging
* Licensing

Candidate selection must be finalized only after current 2026 license verification.

This is especially important because model/library licensing descriptions vary across the research material.

---

# 17. Recommendations Upgrade

Preserve the current explained recommendation engine.

Improve it incrementally.

Possible features:

* BPM distance
* Key compatibility
* Energy direction
* Vocal overlap risk
* Structure
* User rating
* Recent usage
* Transition history

Every recommendation should contain actual reasons from the scoring engine.

Example:

**Next Track**

Score: 87

Reasons:

* BPM +1.3
* compatible key
* energy 6.1 â†’ 7.2
* low vocal overlap at transition point

Never generate an explanation independently from the values used to produce the ranking.

The supplied plan already identifies this consistency between score and explanation as a required property.

---

# 18. Duplicate Detection Upgrade

Keep SHA-256.

It remains useful for exact duplicates.

Add optional acoustic fingerprinting later.

## Exact

Same bytes/hash.

## Acoustic

Potentially same recording but:

* Different bitrate
* Different codec
* Different metadata
* Different container
* Re-exported file

## Relocation

Fingerprint/hash can also assist with:

**Missing track â†’ Locate folder â†’ match moved recording â†’ reconnect existing library record**

This preserves analysis and cues instead of creating another track.

The source specifically identifies acoustic duplicate detection and relocated-file matching as extensions to the existing exact-hash behavior.

---

# 19. Electron Security Hardening

Audit:

* `contextIsolation`
* `nodeIntegration`
* sandbox
* preload
* IPC
* filesystem APIs
* process spawning
* XML/tag parsing

Use:

* typed IPC
* allowlisted commands
* schema validation
* sanitized metadata

External media and metadata should be treated as untrusted input.

The source identifies over-permissive IPC and malformed metadata/audio as concrete risk areas to inspect.

---

# 20. Installer / Upgrade Lifecycle

Because this is an existing application, release engineering is part of the feature work.

Test:

### Fresh install

New user.

### Upgrade

Previous app â†’ new version.

Verify:

* Library
* Cues
* Manual corrections
* Settings
* Jobs
* Stems

### Failed migration

Original data remains recoverable.

### Rollback

Where supported, determine whether the previous app version can safely reopen the old DB/schema.

### Uninstall

Explicitly define whether user data remains or is deleted.

The source specifically includes fresh install, upgrade, rollback and uninstall in the validation matrix.

---

# 21. Combined Implementation Order

## Phase 0

**Audit + regression baseline**

No major architecture changes yet.

â†“

## Phase 1

**Storage + identity + jobs + migration safety**

â†“

## Phase 2

**Analysis versioning + overrides + benchmarks**

â†“

## Phase 3

**Streaming playback + AudioWorklet + waveform cache**

â†“

## Phase 4

**Review + metadata/export + security**

â†“

Parallel capability development:

### Phase 5A

**Stems integration**

### Phase 5B

**Two-deck mixing**

â†“

## Phase 6

**Recommendations upgrade**

â†“

## Phase 7

**Acoustic duplicates + relocation**

â†“

## Phase 8

**Advanced mixer / stems mashup / performance features**

---

# 22. Immediate Development Backlog

The first actionable backlog should be:

### UPG-001 â€” Create regression baseline

Capture existing functionality and tests.

### UPG-002 â€” Benchmark current Dexie library

10k / 50k / 100k. Synthetic gate met 2026-09-23 CT on ones4live (v15 tokens/bigrams + near-end deep jump + persisted count): 100k first-page reopen 7.8 ms, cold search 118.1 ms, deep jump 5.6 ms (baseline 372.7 / 1525 / 1139.6). Real-device acceptance still Open.

### UPG-003 â€” Audit current job scheduler

Crash/cancel/restart/multi-window tests.

### UPG-004 â€” Protect manual analysis corrections

BPM/key/grid must survive re-analysis.

### UPG-005 â€” Introduce analyzer version registry

Add analyzer ID/version/parameters without changing algorithms yet.

### UPG-006 â€” Profile current playback engine

Confirm actual decoder path and RAM behavior.

### UPG-007 â€” Long-file playback test

1h / 2h / 3h files.

### UPG-008 â€” Device recovery tests

USB/BT/hotplug/sleep-wake.

**Software Partial (2026-09-23):** shared helpers in `app/src/audio/devices.ts` (`watchOutputDevices`, `recoverOutputSelection`, `setAudioOutputDevice`, `attachAudioContextRecovery`). Mix Mode re-enumerates on `devicechange`, falls back to system default with an amber status when the selected sink is gone, and attaches context recovery. Inspector `Player` shares `setOutputDevice` and App attaches the same context-recovery helper. Unit tests cover policy with mocks.

**Still Open (acceptance):** physical USB/BT unplug while playing, Bluetooth drop, and sleep/wake soak on real hardware. Do not treat UI messaging alone as acceptance.

### UPG-009 â€” Export round-trip regression suite

Rekordbox XML/M3U8.

### UPG-010 â€” Stem service lifecycle audit

Start/cancel/crash/restart/GPU behavior.

### UPG-011 â€” Two-deck technical spike

After streaming architecture is established.

### UPG-012 â€” Installer upgrade/rollback test

Previous release â†’ upgraded release.

---



---

## Status as of 0.3.2+

Software status for the actionable backlog and phases. **Acceptance-only** items
(physical devices, signed installers, 100k cold-search gates) stay Open even when
related code exists. Do not treat UI presence as phase completion without tests.

### UPG backlog

| ID | Item | Status |
|---|---|---|
| UPG-001 | Regression baseline (lint/test/build/verify scripts) | Done |
| UPG-002 | Dexie library benchmark (10k/50k/100k acceptance) | Done (software synthetic) - 100k firstPage 372.7->7.8 ms, coldSearch 1525->118.1 ms, lastPage 1139.6->5.6 ms (all <200); real-device Open |
| UPG-003 | Job scheduler audit (lease/crash/cancel/multi-window) | Done (software) â€” physical multi-window soak Open |
| UPG-004 | Protect manual BPM/key/grid across re-analysis | Done |
| UPG-005 | Analyzer version registry | Done |
| UPG-006 | Playback engine profile / decoder path | Partial â€” Worklet path in use; formal RAM profile Open |
| UPG-007 | Long-file playback (1h/2h/3h bounded memory) | Partial â€” inspector + Mix Mode MediaElement streaming decks; analysis still refuse-by-default; physical 1h/2h/3h soak Open |
| UPG-008 | Device recovery (USB/BT/hotplug/sleep-wake) | Partial - software hooks (devicechange fallback + context resume); physical hotplug/sleep-wake soak Open |
| UPG-009 | Export round-trip regression (XML/M3U8) | Partial â€” unit coverage + review gate; DJ-software round-trip audit Open |
| UPG-010 | Stem service lifecycle | Partial â€” Electron supervise + client; packaged-app / GPU-OOM gates Open |
| UPG-011 | Two-deck technical spike | Done (Mix Mode software) |
| UPG-012 | Installer upgrade/rollback on real profile | Open (acceptance); installer NotSigned |
| leftover-playlists | In-app playlists | Done (software) |
| leftover-file-log | Electron file log sink + Settings | Done (software) |
| leftover-pyramid | On-disk peak pyramid | Done (software) |
| leftover-cold-search | Cold search without SQLite | Done (software) - v15 token/bigram index; synthetic 100k <200 ms; real-device Open |
| leftover-phrase | Phrase estimation on effective grid | Done (software heuristic; no labelled corpus) |
| leftover-hpss | Median HPSS + bass chroma key support | Done (software heuristic; detectKey fallback kept) |
| leftover-energy-renorm | Library energy percentile 0-10 display | Done (software; raw features retained) |
| leftover-audition | Transition audition from next-track ranking | Done (software; Mix Mode not rewritten) |

### Phases 0â€“8

| Phase | Focus | Status |
|---|---|---|
| 0 | Audit + regression baseline | Done |
| 1 | Storage + identity + jobs + migration safety | Done (Dexie v13; SQLite migration deferred) |
| 2 | Analysis versioning + overrides + benchmarks | Done (software); labeled corpus / EBU cert Open |
| 3 | Streaming playback + AudioWorklet + waveform cache | Partial â€” Worklet + zoom/pan + peak pyramid + inspector + Mix `loadStream` wired; analysis still refuses oversized PCM; multi-hour physical acceptance Open |
| 4 | Review + metadata/export + security | Partial â€” review gate on export/tag-write; Authenticode Open |
| 5A | Stems integration | Partial â€” service + UI + supervise; Demucs physical/OOM Open |
| 5B | Two-deck mixing | Done (software) |
| 6 | Recommendations upgrade | Partial - scoring UI + audition payload/Mix preview; heuristic only; not a learned model |
| 7 | Acoustic duplicates + relocation | Partial â€” fingerprints + single/batch relocate; large-library acceptance Open |
| 8 | Advanced mixer / stems mashup / performance | Open |


# 23. Upgrade Decision Gates

Before committing engineering effort:

## Database Gate

**Does existing Dexie meet required performance and reliability?**

Yes â†’ preserve.

No â†’ migrate.

## Playback Gate

**Can the existing playback core support bounded-memory streaming and accurate multi-deck timing?**

Yes â†’ extend.

No â†’ replace only that layer.

## Analyzer Gate

**Does the existing algorithm meet the agreed benchmark?**

Yes â†’ keep.

No â†’ compare replacements.

## Stem Gate

**Can the current Python service be safely productized?**

Yes â†’ integrate.

No â†’ improve service boundary before changing model.

## License Gate

Verify actual current licenses before selecting:

* DSP libraries
* Time-stretch libraries
* Models
* Model weights

---

# 24. Definition of Done for the Upgrade

The upgrade is successful when:

1. Existing libraries upgrade without data loss.
2. Manual corrections remain authoritative.
3. Existing workflows still function.
4. Background jobs survive crashes.
5. Analysis results are versioned.
6. Long files do not require excessive RAM.
7. Playback recovers from common device changes.
8. Exports match the corrected values shown in the UI.
9. Stem jobs use the common scheduler.
10. Two decks reuse the application's existing grid/cue information.
11. Installation and upgrade paths are tested.
12. New capabilities do not require sacrificing the stability of the original application.

## Final Engineering Principle

**One track identity.
One corrected analysis truth.
One durable job system.
One timing engine.
One controlled migration path.**

Upgrade the application around those principles while keeping everything that already works.
