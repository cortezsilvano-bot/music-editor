/**
 * Monitoring master panel.
 *
 * Affects live playback through MasterBus on the inspector Player and Mix Mode
 * Mixer. Settings persist under music-editor.mastering. Not an album-master
 * export path and not EBU-certified loudness processing.
 */
import { useEffect, useState } from "react";
import { useSetting } from "./settings";
import {
  MASTERING_SETTING_KEY,
  DEFAULT_MASTERING,
  clampMasteringSettings,
  type MasteringSettings,
} from "../audio/mastering";
import type { MasterBus } from "../audio/masterBus";

interface Props {
  /** Live bus to drive (inspector and/or Mix). */
  bus?: MasterBus | null;
  /** Compact layout for embedding in Mix Mode. */
  compact?: boolean;
}

function formatDb(value: number): string {
  if (!Number.isFinite(value)) return "Ã¢â‚¬â€";
  return `${value.toFixed(1)} dB`;
}

export function MasteringPanel({ bus = null, compact = false }: Props) {
  const [raw, setRaw] = useSetting<MasteringSettings>(MASTERING_SETTING_KEY, DEFAULT_MASTERING);
  const settings = clampMasteringSettings(raw);
  const [meter, setMeter] = useState({ peakDb: -60, rmsDb: -60, reductionDb: 0 });

  useEffect(() => {
    bus?.applySettings(clampMasteringSettings(raw));
  }, [bus, raw]);

  useEffect(() => {
    if (!bus || clampMasteringSettings(raw).bypass) {
      setMeter({ peakDb: -60, rmsDb: -60, reductionDb: 0 });
      return;
    }
    let raf = 0;
    const tick = () => {
      setMeter(bus.readMeter());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [bus, raw]);

  const patch = (partial: Partial<MasteringSettings>) => {
    setRaw(clampMasteringSettings({ ...settings, ...partial }));
  };

  const peakPct = Math.max(0, Math.min(100, ((meter.peakDb + 60) / 66) * 100));
  const rmsPct = Math.max(0, Math.min(100, ((meter.rmsDb + 60) / 66) * 100));

  return (
    <div className={`export-panel mastering-panel${compact ? " compact" : ""}`}>
      <div className="panel-head">
        <h3>Mastering (monitor)</h3>
        <label className="toggle">
          <input
            type="checkbox"
            checked={settings.bypass}
            onChange={(e) => patch({ bypass: e.target.checked })}
            aria-label="Bypass monitoring master"
          />
          Bypass
        </label>
      </div>
      <p className="muted mastering-hint">
        Bypass is on by default; uncheck Bypass while playing to hear/see meters.
        {!compact && (
          <>
            {" "}
            Monitor playback only — not album-master export. Export still uses the original file.
          </>
        )}
      </p>

      <div className="ge-row">
        <span className="ge-label">Input</span>
        <input
          type="range"
          min={-24}
          max={12}
          step={0.5}
          value={settings.inputGainDb}
          disabled={settings.bypass}
          aria-label="Master input gain"
          onChange={(e) => patch({ inputGainDb: Number(e.target.value) })}
        />
        <span className="clock">{formatDb(settings.inputGainDb)}</span>
      </div>

      <div className="ge-row">
        <span className="ge-label">Low shelf</span>
        <input
          type="range"
          min={-12}
          max={12}
          step={0.5}
          value={settings.lowShelfDb}
          disabled={settings.bypass}
          aria-label="Master low shelf"
          onChange={(e) => patch({ lowShelfDb: Number(e.target.value) })}
        />
        <span className="clock">{formatDb(settings.lowShelfDb)}</span>
      </div>

      <div className="ge-row">
        <span className="ge-label">High shelf</span>
        <input
          type="range"
          min={-12}
          max={12}
          step={0.5}
          value={settings.highShelfDb}
          disabled={settings.bypass}
          aria-label="Master high shelf"
          onChange={(e) => patch({ highShelfDb: Number(e.target.value) })}
        />
        <span className="clock">{formatDb(settings.highShelfDb)}</span>
      </div>

      <div className="ge-row">
        <span className="ge-label">Soft clip</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={settings.softClip}
          disabled={settings.bypass}
          aria-label="Master soft clip drive"
          onChange={(e) => patch({ softClip: Number(e.target.value) })}
        />
        <span className="clock">{settings.softClip.toFixed(2)}</span>
      </div>

      <div className="ge-row">
        <span className="ge-label">Ceiling</span>
        <input
          type="range"
          min={-6}
          max={0}
          step={0.1}
          value={settings.ceilingDb}
          disabled={settings.bypass}
          aria-label="Master output ceiling"
          onChange={(e) => patch({ ceilingDb: Number(e.target.value) })}
        />
        <span className="clock">{formatDb(settings.ceilingDb)}</span>
      </div>

      <div className="ge-row">
        <span className="ge-label">Output</span>
        <input
          type="range"
          min={-24}
          max={6}
          step={0.5}
          value={settings.outputGainDb}
          disabled={settings.bypass}
          aria-label="Master output gain"
          onChange={(e) => patch({ outputGainDb: Number(e.target.value) })}
        />
        <span className="clock">{formatDb(settings.outputGainDb)}</span>
      </div>

      <div className="master-meters" aria-label="Master meters">
        <div className="meter-row">
          <span className="ge-label">Peak</span>
          <div className="meter-track" role="meter" aria-valuemin={-60} aria-valuemax={6} aria-valuenow={Math.round(meter.peakDb)}>
            <div className="meter-fill peak" style={{ width: `${peakPct}%` }} />
          </div>
          <span className="clock">{formatDb(meter.peakDb)}</span>
        </div>
        <div className="meter-row">
          <span className="ge-label">RMS</span>
          <div className="meter-track" role="meter" aria-valuemin={-60} aria-valuemax={6} aria-valuenow={Math.round(meter.rmsDb)}>
            <div className="meter-fill rms" style={{ width: `${rmsPct}%` }} />
          </div>
          <span className="clock">{formatDb(meter.rmsDb)}</span>
        </div>
        <div className="meter-row">
          <span className="ge-label">GR</span>
          <span className="clock">{formatDb(meter.reductionDb)}</span>
          <button
            type="button"
            className="ghost small"
            onClick={() => patch({ ...DEFAULT_MASTERING })}
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  );
}
