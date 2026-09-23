# Implementation Report — Tranche 1

Date: 2026-09-20
Direction chosen: **rebuild the frontend in React/TypeScript, web-only** (no Rust, no Tauri).

## A. Repository assessment

The existing `Music_editor` directory held a compiled Vite bundle and nothing
else — no source, no source map, no manifests, no migrations, no tests, not a
git repository. See `RESEARCH_IMPLEMENTATION_AUDIT.md` for the evidence. There
was therefore nothing to migrate incrementally; this tranche starts a real
source tree in `app/` and leaves the old build untouched and still served.

Decisions taken, with reasons:

| Decision | Choice | Why |
|---|---|---|
| DSP dependency | none — FFT written here | Verifiable against a naive DFT in our own tests; no supply-chain or licensing question |
| Key algorithm | reimplemented from published profiles | Essentia is AGPL and cannot be linked into this app |
| Beat tracking | DP tracker (Ellis-style) | Deterministic and explainable; the research's fast path and fallback |
| Grid storage | analytic anchors, not beat rows | Required by the brief; a fixed-tempo track costs three numbers |
| Analysis rate | mono 22.05 kHz | Research Phase C; halves transform cost with no loss for tempo or chroma |
| Two spectrograms | 1024/256 for onsets, 4096/2048 for chroma | The stages want opposite time/frequency trade-offs |
| Analysis location | Web Worker | Keeps the UI thread free; a crash kills one worker, not the app |

Deferred deliberately: Rust/Tauri core, ONNX/Beat This!, stems in-app (the
separate `server/` service already covers separation).

## B. Files changed

| Path | Purpose | Main change |
|---|---|---|
| `app/package.json` | manifest | new project, npm scripts for every validation command |
| `app/tsconfig.json` | TS config | strict; `noUncheckedIndexedAccess` off because typed-array DSP would drown in non-null assertions |
| `app/vite.config.ts` | build | ES2022, ES-module workers, vitest wiring |
| `app/eslint.config.js` | lint | typescript-eslint + react-hooks, zero-warning policy |
| `app/src/dsp/fft.ts` | FFT | iterative radix-2, cached twiddles; plus a naive DFT used only by tests |
| `app/src/dsp/spectral.ts` | preprocessing | mono downmix, anti-aliased resampling, magnitude STFT |
| `app/src/dsp/onset.ts` | onsets | SuperFlux-style flux over a mel filterbank; band-limited variant for kick |
| `app/src/dsp/tempo.ts` | tempo | autocorrelation tempogram, harmonic accumulation, log-normal prior, octave folding |
| `app/src/dsp/beats.ts` | beats & grid | DP beat tracker, downbeat phase from kick band, analytic grid fitting |
| `app/src/dsp/key.ts` | key | tuning estimate, harmonic chroma, three key profiles, Camelot/Open Key |
| `app/src/analysis/pipeline.ts` | orchestration | one decode feeds all stages; progress, cancellation, versioning, per-stage timings |
| `app/src/workers/analysis.worker.ts` | worker | narrow versioned protocol, coalesced progress, cancellation |
| `app/src/App.tsx` | UI | import, library list, inspector — every value wired to real analysis |
| `app/src/ui/WaveformView.tsx` | waveform | canvas peaks with beat and bar overlays derived from the grid |
| `app/bench/analyze.ts` | bench | runs the real pipeline over fixtures, scores Accuracy1/Accuracy2 when given ground truth |
| `app/src/audio/player.ts` | playback | single deck, seek, beat click scheduled from the grid |
| `app/src/db/library.ts` | storage | Dexie schema v3, automatic/manual separation, `effective*` helpers |
| `app/src/dsp/gridEdit.ts` | grid editing | pure grid transforms: nudge, set beat/downbeat, scale, tap tempo |
| `app/src/dsp/loudness.ts` | loudness | EBU R128 / BS.1770-4, rate-correct K-weighting, gating, true peak |
| `app/src/dsp/energy.ts` | energy | explainable 1-10 model over stored raw features |
| `app/src/metadata/tags.ts` | tags | ID3/Vorbis/MP4 reading via music-metadata; never throws |
| `app/src/export/formats.ts` | export | Rekordbox XML with TEMPO anchors, M3U8, compatibility report |
| `app/src/ui/GridEditor.tsx` | grid UI | every control calls a tested pure function |
| `app/src/ui/ExportPanel.tsx` | export UI | report shown before anything is written |
| `app/bench/loudness-check.ts` | validation | compares measureLoudness against pyloudnorm |

## C. Features completed

**Fully implemented and tested**

- FFT and spectral preprocessing, including an anti-aliasing resampler proven
  to reject above-Nyquist content.
- Onset strength (SuperFlux), full-band and band-limited.
- Tempo estimation with octave handling: recovers 90/110/124/128/140/150 BPM
  from synthetic tracks within ±1 BPM, folds 174 → 87 for the DJ range, reports
  low confidence on noise.
- Beat tracking, downbeat phase, and analytic grid fitting with fixed/dynamic
  classification.
- Key detection with Camelot and Open Key notation, tuning estimation, and
  relative-key ambiguity reporting.
- Analysis pipeline with progress, cancellation at stage boundaries, per-stage
  timings, and `ANALYSIS_VERSION`.
- Worker isolation with a versioned protocol and coalesced progress events.
- UI: file import (drag-drop and picker), library list with live status,
  inspector with confidence chips, waveform with beat/bar overlay.
- Single-deck playback: play/pause (spacebar), click-to-seek, arrow-key scrub,
  volume, playhead driven from the audio clock rather than a timer.
- Beat click scheduled from the detected grid, downbeats an octave up, so a
  grid can be checked by ear instead of taken on trust.
- Persistence in IndexedDB: tracks, peaks and analysis survive a reload.
- Manual BPM override stored separately from the automatic value, with revert;
  re-analysis replaces the automatic result and never touches the override.
- Bench harness with Accuracy1/Accuracy2 scoring.

**Partially implemented**

- Confidence surface: values are computed and shown with amber/red styling, but
  there is no review queue, no "Needs Verification" playlist, and no tag-writing
  threshold policy (Phase I is otherwise not started).
- Waveform: single resolution peak envelope, not the multiresolution pyramid
  with per-band RMS the brief specifies. No zoom or pan yet.

**Not started**

Loudness and energy (F), metadata reading and writing plus export (G),
structure and cues (H), persistent job queue (J), two-deck Mix Mode (K),
recommendations (L), stems integration (M), duplicate detection (N),
virtualized library table, search.

`zustand` and `@tanstack/react-virtual` are installed but not yet imported;
they are staged for the library tranche and are currently dead weight.

**Unverified**

The audio Blob round trip through IndexedDB is not covered by tests:
`fake-indexeddb` does not structured-clone a jsdom Blob, so it returns an empty
object. Blob storage in IndexedDB is standard and expected to work in a real
browser, but it is proven only by using the app, not by the suite.


## Phase coverage against the brief

Honest status against Phases A-N. "Done" means implemented, wired to the UI
where the brief asks for UI, and covered by tests.

| Phase | Area | Status | What is missing |
|---|---|---|---|
| A | Foundations | ~45% | No search/FTS, no settings persistence, no structured logging, no CI, no feature flags, single worker with no restart recovery; one Dexie version, so the migration path is untested |
| B | Library, decode, playback, waveform | ~50% | No folder/recursive import, no extension filter or path dedup, no missing-file detection or relocation, no search/sort/filter, no playlists, no device selection, no waveform pyramid or cache. Tag *reading* now works; tag *writing* is impossible from a browser |
| C | Shared preprocessing | ~60% | No content-hash caching, no silence detection, no analysis-gain record, no per-stage invalidation |
| D | BPM, beats, downbeats, grid | ~80% | No Fourier tempogram, no kick-alignment refinement, no phrase-length estimation, no dynamic-grid marker add/remove. Manual editor now done: set beat, set downbeat, nudge, x2/÷2, explicit BPM, tap tempo, revert |
| E | Key and harmony | ~45% | No HPSS, no local-window voting, no modulation detection, no intro/outro or segment keys, no bass chroma, **no piano verifier panel** |
| F | Loudness and energy | ~80% | Integrated/short-term/momentary LUFS, LRA, sample peak and the explainable energy model are done and cross-validated. True peak is implemented but skipped in the pipeline for speed; the energy curve is per-second, not per-bar |
| G | Metadata writing and export | ~45% | M3U8 and Rekordbox XML with grid anchors, plus a pre-export compatibility report. Tag *writing* cannot be done from a browser at all - see Remaining risks. No cue export yet, because cues do not exist |
| H | Structure, vocals, cues | 0% | Nothing: no segmentation, no vocal activity, no cue generation |
| I | Confidence and review | ~20% | Values and amber/red chips exist and "mark reviewed" persists, but no review queue, no Needs Verification playlist, no threshold policy, no explanation of why confidence is low |
| J | Job scheduler | ~15% | One worker with progress and cancellation; no persistent queue, priority, retry, timeout, panic isolation or restart recovery |
| K | Two-deck Mix Mode | 0% | Nothing: single deck only, no EQ, crossfader, sync, loops or hot cues |
| L | Recommendations | 0% | Nothing |
| M | Stems and mashup | ~10% | The separate `server/` separation service works, but nothing in this app calls it |
| N | Duplicate detection | 0% | Nothing |

**Roughly 35% of the brief** after tranche 2. The data model is the clearest measure: the brief
lists around eighteen entities (Track, AnalysisResult, AnalysisJob, BeatGrid,
GridAnchor, KeyAnalysis, KeySegment, EnergyAnalysis, EnergyFeatures,
TrackSection, CuePoint, Stem, Playlist, MixRecommendation, MashupCandidate,
MixFeedback, UserOverride, AnalysisVersion). One exists - `StoredTrack`, with
`AnalysisResult` and `BeatGrid` embedded in it.

What is done is the analysis spine - the part everything else depends on - plus
enough app around it to hear and correct the results. That ordering was
deliberate: cues, export, recommendations and mix mode are all downstream of a
beat grid you can trust.

## D. Database changes

None. No database exists yet. This is the single largest gap: without it there
is no persistence, so nothing survives a reload, and the brief's central rule —
manual overrides must survive re-analysis — is not yet enforceable. This is the
first item of the next tranche.

## E. Tests and validation

Exact commands and results:

```
npx vitest run          6 files, 64 tests passed
npx tsc -b              exit 0, no errors
npx eslint src          exit 0, no warnings (--max-warnings 0)
npx vite build          built in 1.05s; index 150 kB, worker 13.7 kB, css 2 kB
npx vite-node bench/analyze.ts    5 real tracks analysed
```

Built output verified over HTTP: `/`, the JS bundle, the CSS and the worker
chunk all return 200 and the entry HTML's references resolve.

Bench on the five demo tracks (full pipeline, ~100× realtime):

| Track | BPM | conf | octave | Key | Camelot | Grid |
|---|---|---|---|---|---|---|
| con-pollito-o-con-pollazo | 132.90 | 0.63 | 0.61 | D major | 10B | fixed |
| ella-si-me-olvido | 129.37 | 0.69 | 0.68 | F# minor | 11A | dynamic |
| la-perra-paro-la-lluvia | 128.00 | 0.73 | 0.61 | D major | 10B | dynamic |
| la-revoltoza | 99.35 | 0.67 | 0.52 | D major | 10B | fixed |
| puente-desconocido | 118.72 | 0.74 | 0.63 | C# minor | 12A | fixed |

Tempo output was cross-checked against an independently written Python
estimator using a different onset method and no prior; the two agree on all
five tracks (largest disagreement 1.3 BPM, and one track matched at its
half-time peak). These are measurements, not accuracy figures — there is no
ground truth for this material.

**Two real bugs were found and fixed during development**, both in the tuning
estimator and both caught by tests rather than inspection:

1. Peak frequencies were read from the raw bin centre. At the analysis FFT size
   a bin spans tens of Hz, so the estimate was quantisation noise far larger
   than the offset being measured. Fixed with parabolic interpolation.
2. Deviations were binned on a line, but they are circular: +49 and −49 cents
   are neighbours and were cancelling. Fixed by averaging as unit vectors.

The symptom was a −38 cent tuning estimate on a perfectly tuned fixture, which
smeared the chroma enough to report A minor as C major. Chroma was additionally
moved to a 4096-point window, since at 1024 a bin is wider than a semitone
below middle C.

## F. Remaining risks

- **No persistence (high).** Nothing is stored. Manual overrides cannot exist
  yet, so the brief's most important data-safety rule is unenforced.
- **Algorithm accuracy (medium).** Tempo and key are validated against
  synthetic fixtures and cross-checked on real audio, but there is no labelled
  ground truth, so no accuracy claim is made. Confidence calibration is
  heuristic, not fitted.
- **Web-only ceiling (medium).** Browser sandboxing means no safe in-place
  metadata writing to the user's files and no exclusive-mode audio. Phase G's
  tag writing cannot be delivered as specified on this platform; export to
  downloadable M3U8/Rekordbox XML is still possible.
- **Memory (medium).** Whole decoded tracks are held in memory and the
  spectrogram for a 5-minute track is tens of MB. Fine for a handful of tracks,
  untested at library scale; the brief targets 100,000.
- **Single worker (low).** One worker processes jobs serially with no queue,
  retry, or restart recovery.
- **Technical debt.** Three unused dependencies; waveform is single-resolution;
  no golden-file tests yet.

## G. Next implementation tranche

In dependency order:

1. **Storage.** Dexie schema with migrations, `analysisVersion` on every cached
   record, and automatic/manual values kept in separate columns so an effective
   value prefers the override without destroying the automatic result. Tests for
   migration and override precedence come with it.
2. **Persistent job queue.** Pending/running/failed/cancelled with retry,
   priority, restart recovery and coalesced progress events.
3. **Loudness and energy (Phase F).** EBU R128 integrated/short-term/range and
   true peak, plus the explainable raw-feature energy model.
4. **Waveform pyramid.** Multiresolution min/max/RMS with per-band RMS, cached,
   with zoom and pan.
5. **Manual grid editor.** Set first beat, move grid, x2/÷2, tap tempo, revert —
   the point at which overrides become user-visible.
