"""Attempt-scoped subprocess entry point. Existing DSP/Demucs engines are reused."""
from __future__ import annotations
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import sqlite3
import sys
import threading
import time
from stem_jobs import watch_lease


def run(database: Path, job_id: str, attempt: str):
    threading.Thread(target=watch_lease, args=(database, job_id, attempt), daemon=True).start()
    directory = database.parent / job_id / attempt
    directory.mkdir(parents=True, exist_ok=True)
    started = time.time()
    try:
        import numpy as np
        import soundfile as sf
        import dsp_separator
        import demucs_separator
        with sqlite3.connect(database) as conn:
            row = conn.execute("SELECT options,source_hash FROM jobs WHERE id=?", (job_id,)).fetchone()
        options = json.loads(row[0])
        audio, sr = sf.read(database.parent / job_id / "source.audio", dtype="float32", always_2d=True)
        if not len(audio):
            raise ValueError("Audio is empty")
        if audio.shape[1] == 1:
            audio = np.repeat(audio, 2, axis=1)
        audio = audio[:, :2]
        backend = options.get("backend", "dsp")
        checkpoint = None
        if backend == "demucs":
            separated = demucs_separator.separate(audio, sr, options.get("quality", "balanced"))
            model = demucs_separator.MODEL_NAME
            version = importlib.metadata.version("demucs")
            digest = hashlib.sha256()
            for key, tensor in sorted(demucs_separator._load().state_dict().items()):
                digest.update(json.dumps([key, str(tensor.dtype), list(tensor.shape)]).encode())
                digest.update(tensor.detach().cpu().contiguous().numpy().tobytes())
            checkpoint = digest.hexdigest()
            device = demucs_separator.resolve_device()[1]
            fallback = getattr(demucs_separator, "_fallback_reason", None)
        else:
            separated = dsp_separator.separate(audio, sr)
            model, version, device, fallback = "spectral-dsp", "1", "cpu", None
        if options.get("stems") == "two":
            separated = {"vocals": separated["vocals"], "instrumental": sum(value for key, value in separated.items() if key != "vocals")}
        types = {"vocals": "lead-vocals", "drums": "drums", "bass": "bass", "melody": "melody", "instrumental": "instruments"}
        stems = []
        for key, samples in separated.items():
            filename = f"{key}.wav"
            temporary = directory / f"{key}.tmp"
            sf.write(temporary, np.clip(samples, -1, 1), sr, subtype="PCM_16", format="WAV")
            with temporary.open("r+b") as stream:
                os.fsync(stream.fileno())
            os.replace(temporary, directory / filename)
            stems.append({"file": filename, "name": filename, "type": types.get(key, "uploaded")})
        result = {"job": job_id, "backend": backend, "sampleRate": sr, "elapsedSeconds": round(time.time() - started, 2),
                  "sourceHash": row[1], "modelId": model, "modelVersion": version, "checkpointHash": checkpoint,
                  "algorithmHash": hashlib.sha256(Path(dsp_separator.__file__ if backend == "dsp" else demucs_separator.__file__).read_bytes()).hexdigest(),
                  "device": device, "fallbackReason": fallback, "stems": stems}
    except Exception as error:
        result = {"error": f"{type(error).__name__}: {error}"}
    temporary = directory / "result.tmp"
    with temporary.open("w", encoding="utf-8") as stream:
        json.dump(result, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, directory / "result.json")


if __name__ == "__main__":
    run(Path(sys.argv[1]), sys.argv[2], sys.argv[3])
