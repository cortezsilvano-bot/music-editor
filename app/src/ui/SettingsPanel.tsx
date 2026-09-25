/**
 * In-app settings for feature flags and log level.
 *
 * Binds to the same localStorage keys as features.ts / logger.ts so toggles
 * take effect without DevTools. A reload is only needed for panels that were
 * already mounted behind a flag that just turned off.
 */
import { FEATURE_FLAG_KEYS, useFeatureFlag } from "./features";
import { useSetting } from "./settings";
import {
  FILE_LOG_SETTING_KEY,
  LOG_LEVEL_SETTING_KEY,
  LOG_LEVELS,
  defaultFileLogEnabled,
  type LogLevel,
  isLogLevel,
} from "../util/logger";
import { isDesktop, logPath, openLogFolder } from "../desktop/bridge";
import { useEffect, useState } from "react";
export function SettingsPanel() {
  const [mixMode, setMixMode] = useFeatureFlag(FEATURE_FLAG_KEYS.mixMode);
  const [stems, setStems] = useFeatureFlag(FEATURE_FLAG_KEYS.stems);
  const [duplicates, setDuplicates] = useFeatureFlag(FEATURE_FLAG_KEYS.duplicates);
  const [logLevel, setLogLevel] = useSetting<LogLevel>(LOG_LEVEL_SETTING_KEY, "info");
  const [fileLog, setFileLog] = useSetting<boolean>(FILE_LOG_SETTING_KEY, defaultFileLogEnabled());
  const [timeoutMinutes, setTimeoutMinutes] = useSetting("analysisTimeoutMinutes", 5);
  const [logFilePath, setLogFilePath] = useState<string>("");
  useEffect(() => {
    if (!isDesktop()) return;
    void logPath().then((result) => {
      if (result.ok && result.path) setLogFilePath(result.path);
    });
  }, []);

  return (
    <div className="export-panel">
      <h3>Settings</h3>
      <p className="muted">
        Feature flags default ON. Turning one off hides its view or panel.
        Log level filters structured console lines (default info).
      </p>

      <div className="ge-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={mixMode}
            onChange={(e) => setMixMode(e.target.checked)}
            aria-label="Feature Mix Mode"
          />
          Mix Mode
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={stems}
            onChange={(e) => setStems(e.target.checked)}
            aria-label="Feature Stems"
          />
          Stems
        </label>
        <label className="toggle">
          <input
            type="checkbox"
            checked={duplicates}
            onChange={(e) => setDuplicates(e.target.checked)}
            aria-label="Feature Duplicates"
          />
          Duplicates
        </label>
      </div>

      <div className="ge-row">
        <span className="ge-label">Log level</span>
        <select
          aria-label="Log level"
          value={isLogLevel(logLevel) ? logLevel : "info"}
          onChange={(e) => setLogLevel(e.target.value as LogLevel)}
        >
          {LOG_LEVELS.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </div>

      <div className="ge-row">
        <span className="ge-label">Analysis timeout</span>
        <select
          aria-label="Analysis timeout"
          value={timeoutMinutes}
          onChange={(e) => setTimeoutMinutes(Number(e.target.value))}
        >
          {[2, 5, 15, 30, 60].map((minutes) => (
            <option key={minutes} value={minutes}>
              {minutes} minutes
            </option>
          ))}
        </select>
      </div>

      <div className="ge-row">
        <label className="toggle">
          <input
            type="checkbox"
            checked={fileLog}
            onChange={(e) => setFileLog(e.target.checked)}
            aria-label="File logging"
            disabled={!isDesktop()}
          />
          File logging
        </label>
        {isDesktop() ? (
          <button
            type="button"
            className="ghost small"
            onClick={() => { void openLogFolder(); }}
          >
            Open log folder
          </button>
        ) : (
          <span className="muted">Desktop app only</span>
        )}
      </div>
      {logFilePath && (
        <p className="muted" style={{ fontSize: 12, wordBreak: "break-all" }}>
          Log file: {logFilePath}
        </p>
      )}
    </div>
  );
}
