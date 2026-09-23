"""Stem separation using classical DSP only (NumPy + SciPy).

No model weights, no torch, no network. Quality is well below Demucs, but it is
a real separation - not a band-pass gimmick - and it always works, which makes
it a sane default when the ML backend is unavailable.

Method, per chunk:
  1. STFT both channels.
  2. Harmonic/percussive split by median filtering the magnitude spectrogram
     along time (-> harmonic) and along frequency (-> percussive). This is the
     standard HPSS trick: sustained pitches are smooth in time, transients are
     smooth in frequency.
  3. A "centre-ness" measure, 1 - |L-R|/(|L|+|R|), marks bins panned to the
     middle. Lead vocals and bass usually live there; pads and guitars spread.
  4. Combine those with coarse band weights into four raw masks, then normalise
     the masks so they sum to exactly 1. That makes the four stems add back up
     to the original mix, which matters because the editor lets you re-mix them.
"""

from __future__ import annotations

import numpy as np
from scipy.ndimage import median_filter

N_FFT = 2048
HOP = N_FFT // 4

# HPSS median kernel sizes (bins, frames).
_HARMONIC_SPAN = 31   # frames smoothed over time
_PERCUSSIVE_SPAN = 31  # bins smoothed over frequency

_EPS = 1e-8

# Chunking keeps peak memory flat regardless of track length. A 4 minute track
# at 48 kHz would otherwise need well over a gigabyte for the spectrograms.
_CHUNK_SECONDS = 20.0
_OVERLAP_SECONDS = 1.0


def _window(n: int) -> np.ndarray:
    # Periodic Hann, the correct choice for overlap-add.
    return np.hanning(n + 1)[:-1].astype(np.float32)


def _stft(x: np.ndarray, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    """Return a (bins, frames) complex64 spectrogram, centred like librosa."""
    win = _window(n_fft)
    pad = n_fft // 2
    xp = np.pad(x, (pad, n_fft + pad))
    # sliding_window_view is a view; the multiply below makes the only copy.
    frames = np.lib.stride_tricks.sliding_window_view(xp, n_fft)[::hop]
    return np.fft.rfft(frames * win, axis=1).astype(np.complex64).T


def _istft(spec: np.ndarray, length: int, n_fft: int = N_FFT, hop: int = HOP) -> np.ndarray:
    """Inverse of :func:`_stft` using weighted overlap-add."""
    win = _window(n_fft)
    frames = np.fft.irfft(spec.T, n=n_fft, axis=1).astype(np.float32) * win
    total = (frames.shape[0] - 1) * hop + n_fft
    out = np.zeros(total, np.float32)
    norm = np.zeros(total, np.float32)
    win_sq = win ** 2
    for i in range(frames.shape[0]):
        start = i * hop
        out[start:start + n_fft] += frames[i]
        norm[start:start + n_fft] += win_sq
    out /= np.maximum(norm, _EPS)
    pad = n_fft // 2
    return out[pad:pad + length]


def _band(freqs: np.ndarray, lo: float, hi: float, order: int = 4) -> np.ndarray:
    """Smooth band-pass weight in [0, 1]; Butterworth-shaped, zero phase."""
    high = 1.0 / (1.0 + (lo / np.maximum(freqs, 1e-6)) ** order)
    low = 1.0 / (1.0 + (freqs / hi) ** order)
    return (high * low).astype(np.float32)


def _chunk_masks(left: np.ndarray, right: np.ndarray, sr: int):
    """Four soft masks - vocals, drums, bass, melody - that sum to 1."""
    spec_l = _stft(left)
    spec_r = _stft(right)
    mag_l = np.abs(spec_l)
    mag_r = np.abs(spec_r)
    mid = 0.5 * (mag_l + mag_r)

    harmonic = median_filter(mid, size=(1, _HARMONIC_SPAN), mode="nearest")
    percussive = median_filter(mid, size=(_PERCUSSIVE_SPAN, 1), mode="nearest")
    h_sq = harmonic ** 2
    p_sq = percussive ** 2
    denom = h_sq + p_sq + _EPS
    harm_mask = h_sq / denom
    perc_mask = p_sq / denom

    # Squaring sharpens the centre estimate; wide content falls away faster.
    centre = np.clip(1.0 - np.abs(mag_l - mag_r) / (mag_l + mag_r + _EPS), 0.0, 1.0) ** 2

    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr).astype(np.float32)[:, None]
    vocal_band = _band(freqs, 150.0, 6000.0)
    bass_band = 1.0 / (1.0 + (freqs / 250.0) ** 4)

    vocals = harm_mask * centre * vocal_band
    drums = perc_mask
    bass = harm_mask * bass_band
    melody = np.clip(1.0 - (vocals + drums + bass), 0.0, None)

    masks = np.stack([vocals, drums, bass, melody]).astype(np.float32)
    masks /= masks.sum(axis=0, keepdims=True) + _EPS
    return masks, spec_l, spec_r


def _separate_chunk(chunk: np.ndarray, sr: int) -> np.ndarray:
    """chunk is (samples, 2); returns (4, samples, 2)."""
    n = chunk.shape[0]
    masks, spec_l, spec_r = _chunk_masks(chunk[:, 0], chunk[:, 1], sr)
    out = np.zeros((4, n, 2), np.float32)
    for i in range(4):
        out[i, :, 0] = _istft(spec_l * masks[i], n)
        out[i, :, 1] = _istft(spec_r * masks[i], n)
    return out


def separate(audio: np.ndarray, sr: int) -> dict[str, np.ndarray]:
    """Split stereo float32 audio into vocals / drums / bass / melody.

    Chunks are crossfaded so no seam is audible at the joins.
    """
    if audio.ndim == 1:
        audio = np.stack([audio, audio], axis=-1)
    audio = np.ascontiguousarray(audio[:, :2], dtype=np.float32)
    total = audio.shape[0]

    chunk_len = max(int(_CHUNK_SECONDS * sr), N_FFT * 4)
    fade = min(int(_OVERLAP_SECONDS * sr), chunk_len // 4)
    step = chunk_len - fade

    acc = np.zeros((4, total, 2), np.float32)
    weight = np.zeros(total, np.float32)
    ramp = np.linspace(0.0, 1.0, fade, dtype=np.float32) if fade else None

    start = 0
    while start < total:
        end = min(start + chunk_len, total)
        piece = _separate_chunk(audio[start:end], sr)
        env = np.ones(end - start, np.float32)
        if ramp is not None:
            if start > 0:
                env[:fade] = ramp
            if end < total:
                env[-fade:] = ramp[::-1]
        acc[:, start:end, :] += piece * env[None, :, None]
        weight[start:end] += env
        if end >= total:
            break
        start += step

    acc /= np.maximum(weight, _EPS)[None, :, None]
    names = ("vocals", "drums", "bass", "melody")
    return {name: acc[i] for i, name in enumerate(names)}
