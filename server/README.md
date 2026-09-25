# Stem separation service

Backend for Music Editor's **Stems** panel. The upgraded app uses durable
`/api/studio/jobs/{runId}` jobs on localhost:8787. Restart the service after
upgrading the source; health must report `jobProtocol: 2`.

```powershell
pip install -r requirements.txt
.\run.ps1          # or run.cmd
```

Then open <http://localhost:8787/api/health>.

| File                   | Purpose                                        |
|------------------------|------------------------------------------------|
| `app.py`               | FastAPI routes, job storage, CORS              |
| `demucs_separator.py`  | Hybrid Transformer Demucs backend (optional)   |
| `dsp_separator.py`     | NumPy/SciPy fallback, no model needed          |
| `stem_jobs.py`         | Persistent job execution, leases and cancellation |
| `stem_worker.py`       | Isolated DSP/Demucs attempt and atomic result files |

`PUT /api/studio/jobs/{runId}` submits audio/options idempotently; `GET` reads
status/results; `DELETE` cancels computation. IDs are generated and persisted by
the app's common queue. Reopening the app polls the same ID. A service restart
recovers queued or expired work; completed manifests remain downloadable.
Only complete manifests are published, and downloads cannot expose source files.

Each attempt has a subprocess. Cancellation terminates it; a watchdog exits if
its supervisor's lease expires. At most one separator runs per jobs database,
with three attempts maximum and a one-hour attempt deadline.
Completed/cancelled/failed server files expire after seven days, configurable via
`STEM_RESULTS_TTL_SECONDS` (minimum 60 seconds). App-cached stems are independent
of server retention and stay playable offline. Cancellation tombstones remain.

Model/version, source SHA-256, implementation hash, checkpoint hash for Demucs,
device and CPU fallback reason are included in new results. Existing engines
and model selection are retained. The legacy blocking `/api/studio/separate`
endpoint remains for older clients; its request-abort behavior is unchanged.

Validation from the repository root: `python -m unittest discover -s server -p 'test_*.py' -v`.
Tests require `httpx` for FastAPI's TestClient, in addition to the core service
dependencies. From `app/`, `node scripts/stems-smoke.mjs` runs the Electron-to-Python
DSP workflow on an isolated port/profile and verifies cached stems reopen offline.

Full documentation: [`../docs/SONG_STUDIO.md`](../docs/SONG_STUDIO.md).

## Packaged desktop installs

The Electron builder copies this `server/` tree into `resources/server` (source,
`requirements.txt`, and run scripts only — not a venv, and not Demucs/torch
weights). After install:

```powershell
cd "<install>\resources\server"
pip install -r requirements.txt
```

Or set `MUSIC_EDITOR_SERVER_ROOT` / use **Choose server folder…** in the Stems
panel. The app never auto-starts this service on launch.
