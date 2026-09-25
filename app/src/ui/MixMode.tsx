import type { TrackMetadata } from "../db/catalog";
/**
 * Two-deck Mix Mode (research Phase K).
 *
 * Every control drives the real audio graph. Sync and beat loops read the
 * stored beat grids, so a track whose grid you corrected in the editor mixes
 * with the grid you corrected, not a fresh guess.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Mixer, type Deck, type DeckState } from "../audio/deck";
import { SYSTEM_DEFAULT_OUTPUT_ID, attachAudioContextRecovery, recoverOutputSelection, watchOutputDevices, type OutputDevice } from "../audio/devices";
import { MIX_MODE_STREAM_LIMITS, mixModeUsesStream } from "../audio/decodePolicy";
import { db, effectiveGridOf, type StoredTrack } from "../db/library";
import { displayName } from "../metadata/tags";
import type { AuditionPayload } from "../analysis/audition";
import { MasteringPanel } from "./MasteringPanel";
import { useSetting } from "./settings";
import { MASTERING_SETTING_KEY, DEFAULT_MASTERING, clampMasteringSettings, type MasteringSettings } from "../audio/mastering";

interface Props {
  tracks: TrackMetadata[];
  /** Decoded audio, shared with the editor so nothing is decoded twice. */
  decoded: Map<string, AudioBuffer>;
  onNeedDecode: (track: StoredTrack) => Promise<AudioBuffer | null>;
  /** Optional ranking-to-preview request from the inspector. */
  audition?: AuditionPayload | null;
  onAuditionStarted?: (payload: AuditionPayload) => void;
}

const EMPTY: DeckState = {
  loaded: false,
  streaming: false,
  playing: false,
  positionSec: 0,
  durationSec: 0,
  rate: 1,
  keyLock: true,
  loop: null,
  slip: false,
};

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function MixMode({ tracks, decoded, onNeedDecode, audition, onAuditionStarted }: Props) {
  const mixerRef = useRef<Mixer | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stateA, setStateA] = useState<DeckState>(EMPTY);
  const [stateB, setStateB] = useState<DeckState>(EMPTY);
  const [titles, setTitles] = useState<{ A: string | null; B: string | null }>({ A: null, B: null });
  const [crossfade, setCrossfade] = useState(0.5);
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [deviceNote, setDeviceNote] = useState<string | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState(SYSTEM_DEFAULT_OUTPUT_ID);
  const selectedDeviceIdRef = useRef(selectedDeviceId);
  selectedDeviceIdRef.current = selectedDeviceId;
  const [masteringSettings] = useSetting<MasteringSettings>(MASTERING_SETTING_KEY, DEFAULT_MASTERING);

  // Re-enumerate on devicechange; fall back if the selected sink disappeared.
  useEffect(() => {
    return watchOutputDevices((result) => {
      if (!result.supported) {
        setDeviceNote("This browser cannot list audio outputs.");
        setDevices([]);
        return;
      }
      setDevices(result.devices);
      const recovery = recoverOutputSelection(selectedDeviceIdRef.current, result.devices);
      if (recovery.fellBack) {
        setSelectedDeviceId(recovery.deviceId);
        setDeviceNote(recovery.message);
        const mixer = mixerRef.current;
        if (mixer) {
          void mixer.setOutputDevice(recovery.deviceId).then((ok) => {
            if (!ok) setDeviceNote("Selected output disconnected; could not switch to system default.");
          });
        }
      } else if (result.labelsHidden) {
        setDeviceNote("Device names are hidden on this origin.");
      }
    });
  }, []);

  // The AudioWorklet module must load before any deck exists, and that is
  // async, so the panel reports its own readiness rather than rendering dead
  // controls.
  useEffect(() => {
    let cancelled = false;
    const context = new AudioContext();
    let detachRecovery: (() => void) | null = null;
    Mixer.register(context)
      .then(() => {
        if (cancelled) {
          void context.close();
          return;
        }
        const mixer = new Mixer(context);
        mixer.deckA.onChange = () => setStateA(mixer.deckA.state);
        mixer.deckB.onChange = () => setStateB(mixer.deckB.state);
        mixerRef.current = mixer;
        detachRecovery = attachAudioContextRecovery(context, {
          onSuspended: (message) => setDeviceNote(message),
          shouldResume: () => {
            const m = mixerRef.current;
            return !!m && (m.deckA.state.playing || m.deckB.state.playing);
          },
        });
        setReady(true);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
      detachRecovery?.();
      void context.close();
      mixerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const live = mixerRef.current;
    if (!live || !ready) return;
    live.applyMastering(clampMasteringSettings(masteringSettings));
  }, [ready, masteringSettings]);

  const loadDeck = useCallback(
    async (id: "A" | "B", trackId: string) => {
      try {
        const mixer = mixerRef.current;
        const track = await db.tracks.get(trackId);
        if (!mixer || !track) return;
        const deck = id === "A" ? mixer.deckA : mixer.deckB;
        const grid = effectiveGridOf(track).grid;
        if (mixModeUsesStream(track)) {
          // Long tracks: MediaElement path ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â never decode full PCM into RAM.
          await deck.loadStream(track.audio, track.durationSec, grid);
        } else {
          const buffer = decoded.get(track.id) ?? (await onNeedDecode(track));
          if (!buffer) {
            setError(`Could not decode ${track.name}`);
            return;
          }
          await deck.load(buffer, grid);
        }
        setTitles((t) => ({ ...t, [id]: displayName(track.tags, track.name) }));
        setError(null);
      } catch (reason) { setError(String(reason)); }
    },
    [decoded, onNeedDecode],
  );

  useEffect(() => {
    if (!audition || !ready) return;
    let cancelled = false;
    void (async () => {
      await loadDeck("A", audition.fromTrackId);
      await loadDeck("B", audition.toTrackId);
      const mixer = mixerRef.current;
      if (cancelled || !mixer) return;
      mixer.deckA.seekSeconds(audition.fromStartSec);
      mixer.deckB.seekSeconds(audition.toStartSec);
      // Stream decks: tempo via playbackRate + phase seek ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â not WSOLA. Still useful.
      mixer.deckB.syncTempoTo(mixer.deckA);
      mixer.deckB.syncPhaseTo(mixer.deckA);
      mixer.setCrossfade(0.35);
      await mixer.deckA.play();
      await mixer.deckB.play();
      onAuditionStarted?.(audition);
    })().catch((reason) => { if (!cancelled) setError(String(reason)); });
    return () => { cancelled = true; };
  }, [audition, ready, loadDeck, onAuditionStarted]);

  const mixer = mixerRef.current;

  if (error) return <div className="export-panel"><h3>Mix Mode</h3><p className="conf red">{error}</p></div>;
  if (!ready || !mixer) {
    return (
      <div className="export-panel">
        <h3>Mix Mode</h3>
        <p className="muted">Starting the audio engine...</p>
      </div>
    );
  }

  const anyStreaming = stateA.streaming || stateB.streaming;

  return (
    <div className="mix-mode">
      <div className="ge-row mix-mode-head">
        <h3 className="mix-title">Mix Mode</h3>
        <p className="muted" style={{ margin: 0 }}>
          Two decks, EQ, crossfade, sync.
          {anyStreaming
            ? " Streaming deck(s): tempo/phase sync is media-clock (not WSOLA); move the crossfader to hear the join."
            : null}
        </p>
      </div>
      {anyStreaming && (
        <p className="notice warn" role="status">
          {MIX_MODE_STREAM_LIMITS}
        </p>
      )}
      <MasteringPanel bus={mixer.masterBus} compact />

      <div className="decks">
        <DeckPanel
          id="A"
          deck={mixer.deckA}
          state={stateA}
          title={titles.A}
          other={mixer.deckB}
          tracks={tracks}
          onLoad={(id) => void loadDeck("A", id)}
        />
        <DeckPanel
          id="B"
          deck={mixer.deckB}
          state={stateB}
          title={titles.B}
          other={mixer.deckA}
          tracks={tracks}
          onLoad={(id) => void loadDeck("B", id)}
        />
      </div>

      <div className="crossfader">
        <span className="ge-label">A</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={crossfade}
          onChange={(e) => {
            const v = Number(e.target.value);
            setCrossfade(v);
            mixer.setCrossfade(v);
          }}
        />
        <span className="ge-label">B</span>
        <span className="muted">
          {mixer.latency.sampleRate} Hz Ãƒâ€šÃ‚Â· {(mixer.latency.output * 1000).toFixed(0)} ms out
        </span>
        {Mixer.supportsOutputSelection && devices.length > 0 && (
          <select
            className="path"
            aria-label="Mix output device"
            value={selectedDeviceId}
            onChange={(e) => {
              const id = e.target.value;
              setSelectedDeviceId(id);
              void mixer.setOutputDevice(id).then((ok) => {
                if (!ok) setDeviceNote("Could not switch to that output.");
              });
            }}
          >
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
        )}
        {deviceNote && <span className="notice warn" role="status">{deviceNote}</span>}
      </div>
    </div>
  );
}

interface DeckProps {
  id: "A" | "B";
  deck: Deck;
  other: Deck;
  state: DeckState;
  title: string | null;
  tracks: TrackMetadata[];
  onLoad: (trackId: string) => void;
}

function DeckPanel({ id, deck, other, state, title, tracks, onLoad }: DeckProps) {
  const [, force] = useState(0);
  const repaint = () => force((n) => n + 1);
  const [query, setQuery] = useState("");
  const matches = query.trim()
    ? tracks.filter((t) => displayName(t.tags, t.name).toLowerCase().includes(query.trim().toLowerCase()))
    : tracks;

  return (
    <div className="deck">
      <div className="ge-row">
        <strong>Deck {id}</strong>
        <input
          className="path"
          aria-label={`Search deck ${id} tracks`}
          placeholder="Filter tracks..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select
          className="path"
          aria-label={`Load deck ${id}`}
          value=""
          onChange={(e) => {
            if (e.target.value) onLoad(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="">Load track...</option>
          {matches.slice(0, 100).map((t) => (
            <option key={t.id} value={t.id}>
              {displayName(t.tags, t.name)}
            </option>
          ))}
        </select>
        {matches.length > 100 && <span className="muted">First 100 of {matches.length} matches. Refine the search to find another track.</span>}
        <button className="ghost small" onClick={() => deck.eject()} disabled={!state.loaded}>
          Eject
        </button>
      </div>

      <div className="ge-row">
        <span className="value">{title ?? "- empty -"}</span>
        {state.streaming && <span className="conf amber">streaming</span>}
      </div>

      <div className="ge-row">
        <button
          className="primary"
          disabled={!state.loaded}
          onClick={() => (state.playing ? deck.pause() : void deck.play())}
        >
          {state.playing ? "Pause" : "Play"}
        </button>
        <button className="ghost small" disabled={!state.loaded} onClick={() => deck.seekSeconds(0)}>
          Cue
        </button>
        <span className="clock">
          {formatTime(state.positionSec)} / {formatTime(state.durationSec)}
        </span>
        <span className="muted">
          {deck.effectiveBpm ? `${deck.effectiveBpm.toFixed(2)} BPM` : "no grid"}
        </span>
      </div>

      <div className="ge-row">
        <span className="ge-label">Tempo</span>
        <input
          type="range"
          min={0.9}
          max={1.1}
          step={0.001}
          value={state.rate}
          disabled={!state.loaded}
          onChange={(e) => deck.setRate(Number(e.target.value))}
        />
        <span className="clock">{((state.rate - 1) * 100).toFixed(1)}%</span>
        <label className="toggle" title={state.streaming ? "WSOLA key-lock needs full PCM" : undefined}>
          <input
            type="checkbox"
            checked={state.keyLock}
            disabled={state.streaming}
            onChange={(e) => deck.setKeyLock(e.target.checked)}
          />
          Key lock
        </label>
      </div>

      <div className="ge-row">
        <span className="ge-label">Sync</span>
        <button
          className="ghost small"
          disabled={!state.loaded}
          title={state.streaming || other.state.streaming ? "Media-clock sync (not WSOLA)" : undefined}
          onClick={() => {
            deck.syncTempoTo(other);
            deck.syncPhaseTo(other);
            repaint();
          }}
        >
          Beat sync
        </button>
        <button
          className="ghost small"
          disabled={!state.loaded}
          title={state.streaming || other.state.streaming ? "Media-clock sync (not WSOLA)" : undefined}
          onClick={() => {
            deck.syncTempoTo(other);
            deck.syncPhaseTo(other, true);
            repaint();
          }}
        >
          Bar sync
        </button>
        <button className="ghost small" disabled={!state.loaded} onClick={() => deck.nudge(-0.03)}>
          {"< Nudge"}
        </button>
        <button className="ghost small" disabled={!state.loaded} onClick={() => deck.nudge(0.03)}>
          {"Nudge >"}
        </button>
      </div>

      <div className="ge-row">
        <span className="ge-label">EQ</span>
        {(["low", "mid", "high"] as const).map((band) => (
          <label key={band} className="slider">
            {band}
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              defaultValue={0.5}
              onChange={(e) => deck.setEq(band, Number(e.target.value))}
            />
          </label>
        ))}
        <label className="slider">
          gain
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            defaultValue={1}
            onChange={(e) => deck.setGain(Number(e.target.value))}
          />
        </label>
      </div>

      <div className="ge-row">
        <span className="ge-label">Loop</span>
        {[1, 2, 4, 8, 16].map((beats) => (
          <button
            key={beats}
            className="ghost small"
            disabled={!state.loaded || state.streaming}
            title={state.streaming ? "Beat loops need full PCM" : undefined}
            onClick={() => {
              deck.setBeatLoop(beats);
              repaint();
            }}
          >
            {beats}
          </button>
        ))}
        <button className="ghost small" disabled={!state.loop || state.streaming} onClick={() => { deck.scaleLoop(0.5); repaint(); }}>
          /2
        </button>
        <button className="ghost small" disabled={!state.loop || state.streaming} onClick={() => { deck.scaleLoop(2); repaint(); }}>
          x2
        </button>
        <button className="ghost small" disabled={!state.loop || state.streaming} onClick={() => { deck.clearLoop(); repaint(); }}>
          Exit
        </button>
        <label className="toggle" title={state.streaming ? "Slip needs full PCM" : undefined}>
          <input
            type="checkbox"
            checked={state.slip}
            disabled={state.streaming}
            onChange={(e) => { deck.setSlip(e.target.checked); repaint(); }}
          />
          Slip
        </label>
        {state.loop && (
          <span className="conf amber">
            {state.loop.beats} beats Ãƒâ€šÃ‚Â· {state.loop.startSec.toFixed(2)}s
          </span>
        )}
      </div>

      <div className="ge-row">
        <span className="ge-label">Roll</span>
        {[0.25, 0.5, 1, 2, 4].map((beats) => (
          <button
            key={beats}
            className="ghost small"
            disabled={!state.loaded || state.streaming}
            title={state.streaming ? "Rolls need full PCM" : undefined}
            onPointerDown={() => { deck.startRoll(Math.max(1, Math.round(beats))); repaint(); }}
            onPointerUp={() => { deck.releaseRoll(); repaint(); }}
            onPointerLeave={() => { if (state.loop) { deck.releaseRoll(); repaint(); } }}
          >
            {beats < 1 ? `1/${1 / beats}` : beats}
          </button>
        ))}
      </div>

      <div className="ge-row">
        <span className="ge-label">Hot cues</span>
        {[1, 2, 3, 4].map((index) => {
          const cue = deck.hotCues.find((c) => c.index === index);
          return (
            <button
              key={index}
              className="ghost small"
              disabled={!state.loaded}
              title={cue ? `${cue.timeSec.toFixed(2)}s - right-click to clear` : "Set cue here"}
              onClick={() => {
                if (cue) deck.jumpToHotCue(index);
                else deck.setHotCue(index);
                repaint();
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                deck.clearHotCue(index);
                repaint();
              }}
            >
              {cue ? `${index} ÃƒÂ¢Ã¢â‚¬â€Ã‚Â` : index}
            </button>
          );
        })}
      </div>
    </div>
  );
}
