# Research Implementation Audit — Music Editor

Date: 2026-09-20
Scope: `F:\Dev_apps\Music_editor`, assessed against A.txt and B.txt.

## 0. Headline finding

**There is no source code for this application.** The directory contains a
compiled Vite build and nothing else. The assignment assumes a Rust workspace,
Tauri configuration, SQLite migrations, tests, CI and frontend sources. None of
these exist here, or anywhere else on this machine.

Evidence gathered by inspection:

| Checked for | Result |
|---|---|
| `package.json`, `Cargo.toml`, `tauri.conf.json` in project | none |
| `src/`, `src-tauri/`, `migrations/`, `tests/` | none |
| Source maps (`.map`, `sourceMappingURL`, `sourcesContent`) | none |
| Git repository | not a git repo |
| `Music_editor.zip` (archived copy) | 24 entries, same build, no source |
| `server.zip` | backup of this folder including the new service; no source |
| Rust/Tauri music project elsewhere on `F:` or `C:` | none — only Escribe-Libre and secure_ones4, unrelated apps |

What does exist:

```
index.html                       409 B    <title>My Google AI Studio App</title>
assets/index-sFvWa7_m.js         597 KB   minified, no source map
assets/index-CLJaJMFp.css         79 KB
demo/*.mp3                        5 files
tabla/                            a second, separate compiled app
server/                           stem separation service added this session
```

The `<title>` identifies this as a **Google AI Studio** export. The editable
source almost certainly still exists in that AI Studio project rather than on
disk. Recovering it is the highest-value action available and is a prerequisite
for any incremental upgrade.

Rust 1.98.1 and npm 12.0.2 are installed, so a native build path is viable.

## 1. What the compiled app actually implements

Measured by scanning the bundle for feature markers:

| Capability | Occurrences in bundle | Assessment |
|---|---|---|
| Key / Camelot / Open Key | `camelot` 0 | absent |
| BPM / tempo analysis | `bpm` 4, `tempo` 6 | UI strings only, no analysis |
| Beat grid / downbeat | `beatgrid` 0, `downbeat` 0 | absent |
| Cue points | `cue` 0 | absent |
| Loudness | `lufs` 35, `loudness` 10 | some real work present |
| Waveform | `waveform` 6 | basic peaks only |
| Rekordbox XML / M3U8 | `rekordbox` 0, `m3u` 0 | absent |
| Persistence | `localStorage` 6, `indexedDB.open` 1, `sqlite` 0 | no database |
| Stems | mixer UI, timeline tracks | UI present; backend added this session |

Roughly **95% of the target feature set does not exist in any form.** This is
not an upgrade of an existing analysis application; it is a ground-up build of
a Rekordbox-class product.

## 2. Features that look complete in the UI but are not functional

This is the category the assignment explicitly asks for, and it is the most
actionable finding.

The bundle bakes in three backend URLs at build time. Only one was ever set:

```js
m3 = { VITE_STEM_SEPARATION_URL: "http://localhost:8787/api/studio/separate" }
```

| Feature | Env var | Inlined value | State |
|---|---|---|---|
| Stem separation | `VITE_STEM_SEPARATION_URL` | set | **fixed this session** — service implemented in `server/` |
| Voice Fix | `VITE_VOICE_FIX_BACKEND_URL` | **undefined** | dead: throws `ProviderNotConfiguredError` |
| Audio generation | `VITE_AUDIO_GEN_URL` | **undefined** | dead: no backend |

Additionally:

- **The "Split Stems" button in the right-hand drawer is `disabled:!0`** —
  hardcoded in the compiled bundle, not config-driven. It can never enable. The
  working path is Song Studio → Stem Separation. Fixing the button needs the
  source.
- The stem panel reports "Provider configured" from a non-empty URL string with
  no health check, so it claimed readiness while nothing was listening on 8787.

## 3. Licensing constraints carried from B.txt

These bind any implementation and should be settled before code is written.

| Component | License reality | Consequence |
|---|---|---|
| madmom | BSD code, **CC BY-NC-SA pretrained weights** | cannot ship weights commercially; retrain or avoid |
| Essentia | AGPL | cannot link into a closed core; reimplement the key algorithm |
| Rubber Band | GPL-or-commercial | use Signalsmith Stretch (MIT) as default |
| Demucs / HTDemucs | MIT stated; open issue #327 on weight redistribution | acceptable, but resolve the weights question before shipping |
| Beat This! (ISMIR 2024) | permissive | preferred accuracy path for beats/downbeats |

The service added this session downloads Demucs weights at runtime into the
user's own cache rather than bundling them, which sidesteps redistribution.

## 4. Other findings

- **`.env` contains a live `ANTHROPIC_API_KEY`** and sits in the web root. A
  plain `python -m http.server` in this folder serves it. `serve.py` was added
  to block dotfiles; the key should still be rotated and the file moved out of
  any served directory.
- **No build, lint, test or CI configuration exists**, so the assignment's
  required validation commands (`cargo fmt`, `cargo clippy`, `cargo test`,
  `npm typecheck/lint/test/build`) have nothing to run against.
- `tabla/` is a second unrelated compiled app plus ~265 MB of WAV files, and
  `default.php` suggests it was deployed to a PHP host.

## 5. Implementation matrix

`Blocked` means blocked on the missing source, not on effort.

| Research feature | Recommendation | Current | Gap | Risk | Chosen implementation | Files | Test strategy | Status |
|---|---|---|---|---|---|---|---|---|
| Stem separation | HTDemucs (MIT) default | none | backend absent | Low | HTDemucs service, DSP fallback, weights fetched not bundled | `server/` | round-trip API tests, reconstruction error | **Done** |
| Core language | Rust workspace | none | no Rust at all | High | greenfield `core/` workspace | — | `cargo test` | Not started |
| Tauri 2 shell | Tauri + React/TS | static build, no source | no shell, no source | High | new Tauri 2 app | — | `tauri build` | Blocked on source |
| Decode | symphonia | browser `decodeAudioData` | no native decode | Med | symphonia in Rust core | — | golden-file decode | Not started |
| Beat/downbeat | DSP tempogram + DP tracker, Beat This! | absent | total | High | Rust DSP first, ONNX later | — | `bench/` vs ground truth | Not started |
| Key/Camelot | HPCP + profile correlation | absent | total | High | Rust DSP, reimplemented (Essentia is AGPL) | — | key exact + fifth-weighted | Not started |
| Loudness | ebur128 | partial LUFS in bundle | unverified, not persisted | Med | `ebur128` crate | — | golden values | Not started |
| Waveform pyramid | multiresolution + binary IPC | basic peaks | no pyramid, no cache | Med | Rust generator + mmap cache | — | cache header golden test | Not started |
| Database | rusqlite, WAL, FTS5 | localStorage only | no DB, no migrations | High | rusqlite + migrations | — | migration tests | Not started |
| Cues / structure | beat-synchronous analysis | absent | total | High | after beat grid exists | — | phrase alignment | Not started |
| Export | Rekordbox XML, M3U8 | absent | total | Med | after data model exists | — | golden XML | Not started |
| Job scheduler | persistent queue | absent | total | Med | Rust + SQLite-backed queue | — | restart recovery | Not started |
| Mix Mode | two-deck, lock-free RT | absent | total | High | last, after grid stability | — | underrun counters | Not started |

## 6. Why implementation cannot proceed exactly as specified

The assignment requires incremental migration, preservation of working
functionality, and no scaffolds labelled complete. With no source:

- There is nothing to migrate incrementally.
- "Preserve useful features already present" cannot be honoured, because those
  features exist only as minified output that cannot be edited.
- Phases A–N describe building a professional DJ application from zero — a
  multi-engineer-month program, not a session.

Producing a large Rust/Tauri skeleton and reporting Phases A–B complete would
violate the assignment's own "no fake completion" rule.

## 7. Recommended next action

1. **Export the source from Google AI Studio.** If it exists, the React/TS app
   becomes editable and genuine incremental upgrades start immediately.
2. If it cannot be recovered, start the Rust + Tauri core greenfield and treat
   the current bundle as a disposable prototype: Phase A (workspace, DB,
   migrations, typed IPC, job scheduler) and Phase B (import, decode, playback,
   waveform) as the first real, tested deliverable.

Either way the stem separation service in `server/` stands: it is real, tested,
and its boundary is narrow enough to be replaced by ONNX or a native worker
later, as B.txt recommends.
