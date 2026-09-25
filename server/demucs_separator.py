"""Stem separation with Demucs (Hybrid Transformer), when torch is installed.

This is the good one. It is optional on purpose: torch plus the model weights
are a large install, and the service stays useful without them by falling back
to :mod:`dsp_separator`.

The first call downloads model weights (~80 MB) into the torch hub cache.
"""

from __future__ import annotations

import os
import threading

import numpy as np

MODEL_NAME = os.environ.get("DEMUCS_MODEL", "htdemucs")

# apply_model's `overlap` is how much each analysis window re-covers its
# neighbour. Demucs ships 0.25; 0.10 measured ~1.3x faster on a warm server
# for stems differing from the 0.25 result by only about -21 dB, which is well
# under what you would notice on a timeline. Going below 0.10 buys nothing -
# 0.05 timed identically - so there are only two settings worth offering.
# Benchmark on a long clip and a warm process, or warm-up cost and seam
# effects will both mislead you.
QUALITY_OVERLAP = {"balanced": 0.10, "high": 0.25}
DEFAULT_QUALITY = os.environ.get("DEMUCS_QUALITY", "balanced").lower()

# Torch defaults to physical cores; hyperthreads buy a little more here.
_THREADS = int(os.environ.get("DEMUCS_THREADS", "0")) or (os.cpu_count() or 4)

# Compute device.
#
# "auto" means CUDA if present, otherwise CPU. DirectML is deliberately NOT in
# the automatic path - see `_directml_usable` for why - and has to be asked for
# explicitly with DEMUCS_DEVICE=directml.
DEVICE_PREFERENCE = os.environ.get("DEMUCS_DEVICE", "auto").lower()
_resolved_device = None
_device_label = "cpu"


_dml_probe_result: bool | None = None


def _directml_usable() -> bool:
    """
    Whether DirectML can actually run this model.

    It usually cannot. Every shipped Demucs model is spectrogram-based and needs
    complex tensors for its STFT, and DirectML has no complex support at all.
    Worse, asking it for one does not raise - it aborts the process outright:

        [F] dml_util.cc:118] Invalid or unsupported data type ComplexFloat.

    A try/except cannot catch that, so the check runs in a throwaway subprocess.
    If the child dies, DirectML is marked unusable and the parent carries on
    with CPU. The result is cached; the probe costs a second, once.
    """
    global _dml_probe_result
    if _dml_probe_result is not None:
        return _dml_probe_result

    import subprocess
    import sys

    code = (
        "import torch, torch_directml as d;"
        "torch.randn(8, dtype=torch.complex64, device=d.device(0));"
        "print('ok')"
    )
    try:
        done = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            timeout=60,
        )
        _dml_probe_result = done.returncode == 0 and b"ok" in done.stdout
    except Exception:
        _dml_probe_result = False

    if not _dml_probe_result:
        print(
            "  DirectML found but it cannot handle the complex tensors Demucs "
            "needs; using CPU.",
            flush=True,
        )
    return _dml_probe_result


def _directml_device():
    """
    The AMD/Intel path on Windows.

    CUDA is NVIDIA-only and ROCm is Linux-only, so DirectML is the only way to
    reach an AMD GPU here - but see `_directml_usable`: for Demucs it does not
    currently work, and the device is only returned if the probe passes.
    """
    try:
        import torch_directml
    except Exception:
        return None, None
    try:
        if torch_directml.device_count() < 1:
            return None, None
        if not _directml_usable():
            return None, None
        index = int(os.environ.get("DEMUCS_DML_DEVICE", "0"))
        return torch_directml.device(index), torch_directml.device_name(index)
    except Exception:
        return None, None


def resolve_device():
    """Pick the compute device once and remember it."""
    global _resolved_device, _device_label
    if _resolved_device is not None:
        return _resolved_device, _device_label

    import torch

    if DEVICE_PREFERENCE in ("cpu",):
        _resolved_device, _device_label = torch.device("cpu"), "cpu"
        return _resolved_device, _device_label

    if DEVICE_PREFERENCE in ("auto", "cuda") and torch.cuda.is_available():
        _resolved_device, _device_label = torch.device("cuda"), "cuda"
        return _resolved_device, _device_label

    if DEVICE_PREFERENCE in ("directml", "dml"):
        device, name = _directml_device()
        if device is not None:
            _resolved_device, _device_label = device, f"directml:{name.strip()}"
            return _resolved_device, _device_label

    _resolved_device, _device_label = torch.device("cpu"), "cpu"
    return _resolved_device, _device_label

_model = None
_lock = threading.Lock()
_import_error: str | None = None
_fallback_reason: str | None = None


def available() -> bool:
    """True if torch and demucs can actually be imported."""
    global _import_error
    try:
        import torch  # noqa: F401
        import demucs.pretrained  # noqa: F401
        import demucs.apply  # noqa: F401
    except Exception as exc:  # pragma: no cover - depends on the environment
        _import_error = f"{type(exc).__name__}: {exc}"
        return False
    return True


def status() -> dict:
    device_label = "unknown"
    if available():
        try:
            device_label = resolve_device()[1]
        except Exception:
            device_label = "cpu"
    return {
        "available": available(),
        "model": MODEL_NAME,
        "loaded": _model is not None,
        "device": device_label,
        "devicePreference": DEVICE_PREFERENCE,
        "quality": DEFAULT_QUALITY,
        "overlap": QUALITY_OVERLAP.get(DEFAULT_QUALITY, 0.10),
        "threads": _THREADS,
        "error": _import_error,
    }


def _load():
    """Load the pretrained model once, under a lock (requests are concurrent)."""
    global _model
    if _model is None:
        with _lock:
            if _model is None:
                from demucs.pretrained import get_model

                model = get_model(MODEL_NAME)
                model.eval()
                _model = model
    return _model


def _resample(audio: np.ndarray, src: int, dst: int) -> np.ndarray:
    if src == dst:
        return audio
    from math import gcd

    from scipy.signal import resample_poly

    div = gcd(src, dst)
    return resample_poly(audio, dst // div, src // div, axis=0).astype(np.float32)


def separate(audio: np.ndarray, sr: int, quality: str = "") -> dict[str, np.ndarray]:
    """Split stereo float32 audio into vocals / drums / bass / melody.

    Returned stems are at the *input* sample rate, so they line up with the
    clip already on the editor timeline.
    """
    import torch
    from demucs.apply import apply_model

    torch.set_num_threads(_THREADS)
    overlap = QUALITY_OVERLAP.get(
        (quality or DEFAULT_QUALITY).lower(), QUALITY_OVERLAP["balanced"]
    )
    model = _load()

    if audio.ndim == 1:
        audio = np.stack([audio, audio], axis=-1)
    audio = np.ascontiguousarray(audio[:, :2], dtype=np.float32)

    native = int(model.samplerate)
    resampled = _resample(audio, sr, native)

    wav = torch.from_numpy(resampled.T)  # demucs wants (channels, samples)
    # Demucs is trained on loudness-normalised input; undo it afterwards.
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std()
    wav = (wav - mean) / (std + 1e-8)

    device, label = resolve_device()
    try:
        with torch.no_grad():
            stacked = apply_model(
                model, wav[None], device=device, progress=False, overlap=overlap
            )[0]
    except Exception as exc:
        # A GPU that runs out of memory or hits an unsupported op must not fail
        # the job; the CPU path always works and a slow result beats none.
        if label == "cpu":
            raise
        print(f"  {label} failed ({exc}); falling back to CPU", flush=True)
        globals()["_fallback_reason"] = f"{label}: {type(exc).__name__}: {exc}"
        globals()["_resolved_device"] = torch.device("cpu")
        globals()["_device_label"] = "cpu"
        with torch.no_grad():
            stacked = apply_model(
                model, wav[None], device="cpu", progress=False, overlap=overlap
            )[0]
    # Share the DC offset across the set rather than adding it to every stem,
    # which would make them sum to N times the original offset.
    # Results may live on the GPU; bring them back before touching numpy.
    stacked = stacked.to("cpu")
    stacked = stacked * (std + 1e-8) + mean / stacked.shape[0]

    out: dict[str, np.ndarray] = {}
    # htdemucs emits drums / bass / other / vocals; "other" is the melodic rest.
    rename = {"other": "melody"}
    for source, tensor in zip(model.sources, stacked):
        name = rename.get(source, source)
        stem = tensor.numpy().T.astype(np.float32)
        stem = _resample(stem, native, sr)
        # Resampling can drift by a sample or two; match the input length.
        if stem.shape[0] < audio.shape[0]:
            stem = np.pad(stem, ((0, audio.shape[0] - stem.shape[0]), (0, 0)))
        out[name] = stem[: audio.shape[0]]
    return out
