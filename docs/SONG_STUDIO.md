# Stem Separation Service

> This service is now driven by the current application in [`../app`](../app),
> via its Stems panel. It was originally written for the legacy build, which is
> archived in [`../legacy`](../legacy).


Song Studio's **Split Stems** feature sends audio to a separation service and
loads the returned stems onto the timeline as separate tracks. The editor does
not separate audio in the browser; without the service running, the feature
cannot work.

The client is built to call:

```
POST http://localhost:8787/api/studio/separate
```

That address is compiled into the bundle (`VITE_STEM_SEPARATION_URL`), so the
service must listen on port **8787**.

## Running it

```powershell
cd server
pip install -r requirements.txt
.\run.ps1
```

Check it came up:

```
http://localhost:8787/api/health
```

Leave it running in its own terminal while you use the editor.

## Backends

The service picks the best backend available at startup.

| Backend    | Quality | Speed (CPU)          | Requirements        |
|------------|---------|----------------------|---------------------|
| **demucs** | High    | ~1.6× faster than realtime | `torch`, `demucs` |
| **dsp**    | Modest  | ~6× faster than realtime   | numpy, scipy only |

Measured on an i7-10700 (8 cores / 16 threads), CPU only.

`demucs` is the Hybrid Transformer model and is used automatically when torch
is installed. The first run downloads ~80 MB of model weights.

`dsp` is a classical fallback — harmonic/percussive median filtering combined
with stereo centre extraction. It is much rougher than Demucs, but it is fast,
needs no model, and its four stems sum back to the original mix exactly.

Force one with the `STEM_BACKEND` environment variable (`demucs`, `dsp`, or
`auto`), or per request via the `options` field.

## API

### `POST /api/studio/separate`

Multipart form:

| Field     | Type   | Notes                                    |
|-----------|--------|------------------------------------------|
| `file`    | file   | WAV, MP3, FLAC or OGG                    |
| `options` | string | JSON, optional                           |

`options` keys:

- `stems` — `"basic"` (default) for vocals/drums/bass/melody, or `"two"` for
  vocals plus a single instrumental bed.
- `backend` — `"demucs"`, `"dsp"` or `"auto"`.
- `quality` — `"balanced"` (default) or `"high"`. Demucs only; see Speed.

Response:

```json
{
  "job": "fc5e19fd...",
  "backend": "demucs",
  "sampleRate": 48000,
  "stems": [
    {
      "name": "my-track - Vocals.wav",
      "type": "lead-vocals",
      "url": "http://localhost:8787/api/studio/stems/fc5e19fd.../my-track%20-%20Vocals.wav"
    }
  ]
}
```

`type` is always a track type the editor recognises, so each stem lands on a
correctly labelled and coloured track.

### `GET /api/studio/stems/{job}/{name}`

Serves a rendered stem as a 16-bit PCM WAV at the input sample rate. The
browser fetches these directly, so CORS is open here too. Jobs are deleted
after an hour (`JOB_TTL_SECONDS`).

### `GET /api/health`

Reports which backend is active and whether Demucs imported successfully.

## Configuration

| Variable          | Default | Purpose                                  |
|-------------------|---------|------------------------------------------|
| `PORT`            | 8787    | Listen port                              |
| `STEM_BACKEND`    | auto    | Force a backend                          |
| `MAX_UPLOAD_MB`   | 200     | Upload size cap                          |
| `JOB_TTL_SECONDS` | 3600    | How long stems stay downloadable         |
| `JOBS_DIR`        | temp    | Where stems are written                  |
| `PUBLIC_BASE_URL` | —       | Override the host in returned stem URLs  |

## Speed

Demucs is the slow part. On an i7-10700 with no CUDA GPU, a 4-minute track
takes around 2.5 minutes. Options, in order of how much they buy you:

1. **`STEM_BACKEND=dsp`** — roughly 4× quicker than Demucs (a 4-minute track in
   about 40 seconds), at clearly lower quality. Best when you are laying out an
   arrangement and will re-run properly later.
2. **`quality: "balanced"`** — the default, already applied. Uses `overlap=0.10`
   instead of Demucs' stock `0.25`: about 1.3× faster, roughly -21 dB of
   difference in the output. Pass `"high"` for the stock setting.
3. **`DEMUCS_THREADS`** — defaults to every logical core. Lower it if you want
   the machine responsive while it runs.

Going below `overlap=0.10` is not worth it; it measures no faster.

An NVIDIA GPU would be worth far more than all of the above, but this machine
has AMD and Intel graphics, which torch cannot use on Windows.

## GPU acceleration

Separation runs on the CPU. Investigated and ruled out on this machine
(AMD Radeon Pro W5500, 8 GB), so it does not get re-tried from scratch:

| Route | Result |
|---|---|
| CUDA | NVIDIA only |
| **ROCm on Windows** | Real since ROCm 7.2 (Jan 2026), but the supported architectures are gfx1100/1101/1200/1201 - RDNA 3 and 4. The W5500 is gfx1012 (RDNA 1), two generations below the minimum. |
| **DirectML, PyTorch** | Cannot run Demucs at all. Every Demucs model needs complex tensors for its STFT, and DirectML has none - requesting one aborts the process rather than raising, so it cannot even be caught. |
| **DirectML, ONNX** | Exports and runs 7x faster than CPU, but the output is wrong by five orders of magnitude. Not an optimiser issue, and not the STFT (DirectML's matmul is accurate to 2.7e-06 at the 4096-wide reduction used). A kernel bug somewhere else in the model. |

The DirectML code path still exists in `demucs_separator.py` behind
`DEMUCS_DEVICE=directml`, gated by a subprocess probe so the hard abort cannot
take down the service. `auto` never selects it.

An RDNA 3/4 Radeon or any NVIDIA card would work; this one will not.

## Troubleshooting

**"Separation failed: Failed to fetch"** — the service is not running, or not
on 8787. Open `http://localhost:8787/api/health` to confirm.

**The Split Stems button in the right-hand drawer is greyed out** — that button
is disabled in the compiled bundle regardless of configuration. Use
**Song Studio → Stem Separation** instead; that is the path that calls the API.

**Separation is slow** — that is Demucs on CPU, and there is no way around it
without an NVIDIA GPU. See *Speed* below.

**"Could not decode that audio"** — the format is not supported by libsndfile.
Convert to WAV or MP3 first.
