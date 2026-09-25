"""Stem separation service for Song Studio.

Implements the contract the editor bundle already expects:

    POST /api/studio/separate
        multipart: file=<audio>, options=<json>
        -> {"stems": [{"name": ..., "type": ..., "url": ...}, ...]}

    GET  /api/studio/stems/{job}/{file}   the rendered stem WAVs
    GET  /api/health                      backend status

The editor fetches each stem URL from the browser, on a different origin to
this service, so CORS has to be open on the downloads as well as the upload.
"""

from __future__ import annotations

import io
from contextlib import asynccontextmanager
import json
import os
import shutil
import tempfile
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import numpy as np
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse

import demucs_separator
import dsp_separator
from stem_jobs import StemJobs

# Stem keys must be values the editor's track-type table knows; anything else
# is silently coerced to "other" and loses its colour and label.
STEM_TYPES = {
    "vocals": "lead-vocals",
    "drums": "drums",
    "bass": "bass",
    "melody": "melody",
    "instrumental": "instruments",
}
STEM_LABELS = {
    "vocals": "Vocals",
    "drums": "Drums",
    "bass": "Bass",
    "melody": "Melody",
    "instrumental": "Instrumental",
}

MAX_UPLOAD_BYTES = int(os.environ.get("MAX_UPLOAD_MB", "200")) * 1024 * 1024
JOB_TTL_SECONDS = int(os.environ.get("JOB_TTL_SECONDS", "3600"))
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").rstrip("/")
FORCE_BACKEND = os.environ.get("STEM_BACKEND", "auto").lower()

JOBS_DIR = Path(os.environ.get("JOBS_DIR", Path(tempfile.gettempdir()) / "song-studio-stems"))
JOBS_DIR.mkdir(parents=True, exist_ok=True)

durable_jobs = StemJobs(JOBS_DIR / "durable", retention_seconds=max(60, int(os.environ.get("STEM_RESULTS_TTL_SECONDS", "604800"))))

@asynccontextmanager
async def lifespan(_app):
    durable_jobs.start()
    try:
        yield
    finally:
        durable_jobs.stop()

app = FastAPI(title="Song Studio stem separation", version="2.0.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _pick_backend(requested: str) -> str:
    choice = (requested or FORCE_BACKEND or "auto").lower()
    if choice == "dsp":
        return "dsp"
    if choice == "demucs":
        if not demucs_separator.available():
            raise HTTPException(
                503,
                "Demucs backend requested but not installed. "
                "Run: pip install demucs torch",
            )
        return "demucs"
    return "demucs" if demucs_separator.available() else "dsp"


def _sweep_old_jobs() -> None:
    """Drop rendered stems once the editor has had time to fetch them."""
    cutoff = time.time() - JOB_TTL_SECONDS
    for entry in JOBS_DIR.glob("*"):
        if entry.name == "durable":
            continue
        try:
            if entry.is_dir() and entry.stat().st_mtime < cutoff:
                shutil.rmtree(entry, ignore_errors=True)
        except OSError:
            pass


def _decode(raw: bytes) -> tuple[np.ndarray, int]:
    try:
        audio, sr = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
    except Exception as exc:
        raise HTTPException(
            415,
            f"Could not decode that audio ({exc}). WAV, MP3, FLAC and OGG are "
            "supported; convert other formats first.",
        ) from exc
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    return audio[:, :2], int(sr)


@app.get("/api/health")
def health() -> dict:
    backend = _pick_backend("")
    return {
        "ok": True,
        "service": "song-studio-separation",
        "jobProtocol": 2,
        "backend": backend,
        "demucs": demucs_separator.status(),
        "dsp": {"available": True},
        "jobs_dir": str(JOBS_DIR),
    }


def job_response(row: dict, request: Request) -> dict:
    response = {"id": row["id"], "status": row["status"], "attempts": row["attempts"],
                "error": row["error"], "errorCode": row["error_code"], "updatedAt": row["updated_at"]}
    if row["status"] == "done" and row["result"]:
        result = json.loads(row["result"])
        base = PUBLIC_BASE_URL or str(request.base_url).rstrip("/")
        for stem in result["stems"]:
            stem["url"] = f"{base}/api/studio/jobs/{row['id']}/stems/{quote(stem['file'])}"
        response["result"] = result
    return response


@app.put("/api/studio/jobs/{job}")
def submit_job(job: str, request: Request, file: UploadFile = File(...), options: str = Form("{}")):
    raw = file.file.read(MAX_UPLOAD_BYTES + 1)
    if not raw or len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Upload is empty or exceeds the configured size limit")
    try:
        opts = json.loads(options)
        if not isinstance(opts, dict) or opts.get("quality", "balanced") not in {"balanced", "high"} or opts.get("stems", "basic") not in {"basic", "two"}:
            raise ValueError("Invalid separation options")
        opts = {"backend": _pick_backend(str(opts.get("backend", ""))), "quality": opts.get("quality", "balanced"), "stems": opts.get("stems", "basic")}
        row = durable_jobs.submit(job, raw, file.filename or "audio", opts)
        return job_response(row, request)
    except ValueError as error:
        raise HTTPException(409, str(error)) from error


@app.get("/api/studio/jobs/{job}")
def get_job(job: str, request: Request):
    try:
        row = durable_jobs.get(job)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if not row:
        raise HTTPException(404, "Unknown separation job")
    return job_response(row, request)


@app.delete("/api/studio/jobs/{job}")
def cancel_job(job: str, request: Request):
    try:
        return job_response(durable_jobs.cancel(job), request)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@app.get("/api/studio/jobs/{job}/stems/{name}")
def download_job_stem(job: str, name: str):
    try:
        row = durable_jobs.get(job)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error
    if not row or row["status"] != "done":
        raise HTTPException(404, "No completed stems")
    result = json.loads(row["result"])
    if name not in {stem["file"] for stem in result["stems"]} or Path(name).name != name:
        raise HTTPException(404, "Unknown stem")
    directory = (durable_jobs.root / job / row["attempt"]).resolve()
    target = (directory / name).resolve()
    if target.parent != directory or not target.is_file():
        raise HTTPException(404, "Missing stem")
    return FileResponse(target, media_type="audio/wav", filename=name)


@app.post("/api/studio/separate")
def separate(
    request: Request,
    file: UploadFile = File(...),
    options: str = Form("{}"),
) -> dict:
    raw = file.file.read(MAX_UPLOAD_BYTES + 1)
    if not raw:
        raise HTTPException(400, "Empty upload.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File exceeds {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")

    try:
        opts = json.loads(options) if options else {}
    except json.JSONDecodeError:
        opts = {}
    if not isinstance(opts, dict):
        opts = {}

    backend = _pick_backend(str(opts.get("backend", "")))
    audio, sr = _decode(raw)

    duration = audio.shape[0] / sr
    started = time.time()
    if backend == "demucs":
        stems = demucs_separator.separate(audio, sr, str(opts.get("quality", "")))
    else:
        stems = dsp_separator.separate(audio, sr)
    elapsed = time.time() - started
    # Separation is long enough that silence looks like a hang; log the rate.
    print(
        f"  separated {duration:.0f}s via {backend} in {elapsed:.0f}s "
        f"({duration / max(elapsed, 1e-6):.2f}x realtime)",
        flush=True,
    )

    # "two" collapses everything that is not a voice into one instrumental bed.
    if str(opts.get("stems", "basic")).lower() in {"two", "2", "vocals"}:
        rest = sum(v for k, v in stems.items() if k != "vocals")
        stems = {"vocals": stems["vocals"], "instrumental": rest}

    _sweep_old_jobs()
    job = uuid.uuid4().hex
    job_dir = JOBS_DIR / job
    job_dir.mkdir(parents=True, exist_ok=True)

    title = Path(file.filename or "source").stem or "source"
    base = PUBLIC_BASE_URL or str(request.base_url).rstrip("/")

    rendered = []
    for key, data in stems.items():
        name = f"{title} - {STEM_LABELS.get(key, key.title())}.wav"
        sf.write(job_dir / name, np.clip(data, -1.0, 1.0), sr, subtype="PCM_16")
        rendered.append(
            {
                "name": name,
                "type": STEM_TYPES.get(key, "uploaded"),
                # name keeps its spaces for the timeline label; the URL must not.
                "url": f"{base}/api/studio/stems/{job}/{quote(name)}",
            }
        )

    return {
        "job": job,
        "backend": backend,
        "sampleRate": sr,
        "elapsedSeconds": round(elapsed, 1),
        "stems": rendered,
    }


@app.get("/api/studio/stems/{job}/{name}")
def download(job: str, name: str) -> FileResponse:
    # Resolve and confirm containment; the name reaches us straight from a URL.
    job_dir = (JOBS_DIR / job).resolve()
    target = (job_dir / name).resolve()
    if job_dir.parent != JOBS_DIR.resolve() or target.parent != job_dir or not target.is_file():
        raise HTTPException(404, "Stem not found or expired.")
    return FileResponse(target, media_type="audio/wav", filename=name)


@app.get("/", response_class=HTMLResponse)
def index() -> str:
    info = health()
    return f"""<!doctype html><meta charset=utf-8>
<title>Song Studio separation</title>
<body style="font:14px system-ui;background:#09090b;color:#ededed;padding:2rem">
<h1 style="font-size:1.1rem">Song Studio stem separation</h1>
<p>Active backend: <strong>{info['backend']}</strong></p>
<p style="color:#a1a1aa">POST audio to <code>/api/studio/separate</code>.
Health at <a style="color:#06b6d4" href="/api/health">/api/health</a>.</p>
</body>"""
