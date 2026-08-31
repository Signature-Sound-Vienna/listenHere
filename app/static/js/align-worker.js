/*
 * align-worker.js
 * Web Worker for in-browser audio alignment using Pyodide (numpy + scipy).
 * Computes chroma features via STFT, aligns recordings using DTW.
 *
 * Architecture:
 *   Main thread: decodes audio to Float32Array @ 22050 Hz (Web Audio API)
 *   This worker: receives PCM arrays, runs Python alignment via Pyodide
 *   Output: alignment JSON (same format as the SSV alignment workflow)
 *
 * Performance notes (10 Hz chroma, full DTW):
 *   5 min audio (~3000 frames): ~5-15 sec/pair
 *   10 min audio (~6000 frames): ~20-60 sec/pair
 *   15 min audio (~9000 frames): ~45-120 sec/pair
 *
 * Memory notes:
 *   Chroma and onset streaming: STFT is never materialised as a full matrix.
 *   Peak extra memory per recording ≈ CHUNK (256) * n_fft floats ≈ 1 MB,
 *   independent of recording length (works for 30+ min files).
 *
 * Score-to-audio alignment:
 *   MIDI → additive sine-wave synthesis → same streaming chroma pipeline.
 *   Two-level DTW: pool features ×2 → unconstrained coarse DTW → interpolate notes.
 */

importScripts("https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.js");

/* Post progress updates to the main thread */
function reportProgress(message, pct) {
  self.postMessage({
    type: "progress",
    message: String(message),
    pct: pct !== undefined && pct !== null ? Number(pct) : -1,
  });
}

/* Post structured step updates for the progress list */
function reportStep(phase, step, file, index, total, elapsed) {
  self.postMessage({
    type: "step",
    phase: String(phase),
    step: String(step),
    file: file != null ? String(file) : null,
    index: index != null ? Number(index) : null,
    total: total != null ? Number(total) : null,
    elapsed: elapsed != null ? Number(elapsed) : null,
  });
}

const PYTHON_CODE = `
import numpy as np
from scipy.interpolate import interp1d
from js import reportProgress, reportStep
import time as _time

SR = 22050
FEATURE_RATE = 10        # Hz — audio-to-audio alignment
HOP = SR // FEATURE_RATE  # 2205 samples
N_FFT = 4096
ANNOTATION_STEP = 0.02   # seconds (50 Hz output grid)

# Score-to-audio alignment
# Uses the same feature rate as audio-to-audio (lower memory, still adequate).
# A two-level scheme: features are pooled by SCORE_DOWNSAMPLE for a cheap
# unconstrained coarse DTW that captures global structure; notes are then
# mapped through the coarse warping path via interpolation.
SCORE_FEATURE_RATE = 10  # Hz (HOP = 2205 samples)
SCORE_HOP  = SR // SCORE_FEATURE_RATE
SCORE_N_FFT = 4096
SCORE_DOWNSAMPLE = 2     # pool by this factor => coarse at 5 Hz
ONSET_N_FFT = 1024       # short window (46 ms) for sharp onset detection
ONSET_WEIGHT = 2.0       # chroma scale-up factor at detected onsets

# Audio-to-audio DTW parameters
COARSE = 4               # coarse pooling factor
SLACK  = 80              # Sakoe-Chiba band half-width (fine frames)


def _apply_options():
    """Override module constants from JS _opt_* globals (if set)."""
    global FEATURE_RATE, HOP, COARSE, SLACK
    global SCORE_DOWNSAMPLE, ONSET_WEIGHT
    v = int(_opt_feature_rate) if int(_opt_feature_rate) > 0 else None
    if v:
        FEATURE_RATE = v
        HOP = SR // v
    v = int(_opt_coarse) if int(_opt_coarse) > 0 else None
    if v:
        COARSE = v
    v = int(_opt_slack) if int(_opt_slack) > 0 else None
    if v:
        SLACK = v
    v = int(_opt_score_downsample) if int(_opt_score_downsample) > 0 else None
    if v:
        SCORE_DOWNSAMPLE = v
    v = float(_opt_onset_weight)
    if v >= 0:
        ONSET_WEIGHT = v


def _stft_setup(audio, n_fft, hop):
    """Shared STFT prep: pad audio, build window, compute n_frames and byte stride."""
    audio = np.asarray(audio, dtype=np.float32)
    audio_pad = np.concatenate([audio, np.zeros(n_fft, dtype=np.float32)])
    window = np.hanning(n_fft).astype(np.float32)
    n_frames = max(1, (len(audio) - n_fft) // hop + 1)
    return audio_pad, window, n_frames, audio_pad.strides[0]


def _pitch_class_map(n_fft):
    """Pre-compute boolean valid-bin mask and per-bin pitch-class (0-11) for chroma folding."""
    freqs = np.fft.rfftfreq(n_fft, d=1.0 / SR)
    valid = freqs > 50
    midi_f = 69.0 + 12.0 * np.log2(np.maximum(freqs[valid], 1e-9) / 440.0)
    return valid, (np.round(midi_f).astype(int) % 12)


def compute_chroma(audio, n_fft=None, hop=None):
    """12-bin L2-normalised chroma — fully streaming.
    Peak extra memory: ~CHUNK*(n_fft + 12) floats, independent of audio length.
    """
    if n_fft is None: n_fft = N_FFT
    if hop  is None: hop  = HOP
    audio_pad, window, n_frames, s = _stft_setup(audio, n_fft, hop)
    valid, pc = _pitch_class_map(n_fft)
    pc_masks = [pc == i for i in range(12)]
    CHUNK = 256
    chroma = np.zeros((12, n_frames), dtype=np.float32)
    for cs in range(0, n_frames, CHUNK):
        ce = min(n_frames, cs + CHUNK)
        frames = np.lib.stride_tricks.as_strided(
            audio_pad[cs * hop:],
            shape=(ce - cs, n_fft),
            strides=(s * hop, s)
        )
        spec = np.fft.rfft(frames * window, axis=1)
        mag = np.abs(spec[:, valid]).astype(np.float32)   # (chunk, valid_bins)
        del spec
        ch = np.zeros((12, ce - cs), dtype=np.float32)
        for i, mask in enumerate(pc_masks):
            if np.any(mask):
                ch[i] = mag[:, mask].sum(axis=1)
        norms = np.linalg.norm(ch, axis=0, keepdims=True)
        norms[norms < 1e-8] = 1.0
        chroma[:, cs:ce] = ch / norms
        del mag, ch
    return chroma   # (12, n_frames), float32


def compute_chroma_score(audio):
    """12-bin chroma at SCORE_HOP resolution for score-to-audio alignment."""
    return compute_chroma(audio, n_fft=SCORE_N_FFT, hop=SCORE_HOP)


def compute_onset_strength(audio, hop=None):
    """Spectral-flux onset strength — fully streaming.
    Uses ONSET_N_FFT short window for temporal resolution; hop defaults to
    SCORE_HOP (chroma_score's), overridable for fix-mode segment features.
    Peak extra memory: 2 * ONSET_N_FFT/2 floats (current + prev frame).
    """
    n_fft = ONSET_N_FFT
    if hop is None:
        hop = SCORE_HOP
    audio_pad, window, n_frames, s = _stft_setup(audio, n_fft, hop)
    CHUNK = 256
    flux = np.zeros(n_frames, dtype=np.float32)
    prev_frame = None                                # last mag row of previous chunk
    for cs in range(0, n_frames, CHUNK):
        ce = min(n_frames, cs + CHUNK)
        frames = np.lib.stride_tricks.as_strided(
            audio_pad[cs * hop:],
            shape=(ce - cs, n_fft),
            strides=(s * hop, s)
        )
        spec = np.fft.rfft(frames * window, axis=1)
        mag = np.abs(spec).astype(np.float32)       # (chunk, bins)
        del spec
        if prev_frame is not None:
            # Prepend last frame of previous chunk for cross-boundary flux
            ext  = np.vstack([prev_frame[np.newaxis, :], mag])  # (chunk+1, bins)
            diff = np.maximum(np.float32(0), ext[1:] - ext[:-1])
            flux[cs:ce] = diff.mean(axis=1)
        else:
            # First chunk: frame 0 has no predecessor → flux = 0
            flux[cs] = np.float32(0.0)
            if ce > cs + 1:
                diff = np.maximum(np.float32(0), mag[1:] - mag[:-1])
                flux[cs + 1:ce] = diff.mean(axis=1)
        prev_frame = mag[-1].copy()
        del mag
    kernel = np.ones(5, dtype=np.float32) / np.float32(5.0)
    flux = np.convolve(flux, kernel, mode='same').astype(np.float32)
    mx = flux.max()
    if mx > 1e-8:
        flux /= mx
    return flux  # (n_frames,)


def build_score_features(chroma, onset):
    """Onset-weighted chroma: scale each frame by (1 + ONSET_WEIGHT * onset),
    then L2-renormalise.  Amplifies attack moments in both score and real audio
    so DTW strongly prefers aligning them together (approximates DLNCO).
    """
    scale = (np.float32(1.0) + np.float32(ONSET_WEIGHT) * onset)  # (n_frames,)
    weighted = chroma * scale[np.newaxis, :]
    norms = np.linalg.norm(weighted, axis=0, keepdims=True)
    norms[norms < 1e-8] = np.float32(1.0)
    return (weighted / norms).astype(np.float32)


def _pool_features(feat, factor):
    """Mean-pool feature matrix along time by integer factor, then L2-renormalise."""
    D, T = feat.shape
    T_c = T // factor
    if T_c == 0:
        return feat
    pooled = feat[:, :T_c * factor].reshape(D, T_c, factor).mean(axis=2)
    norms = np.linalg.norm(pooled, axis=0, keepdims=True)
    norms[norms < 1e-8] = np.float32(1.0)
    return (pooled / norms).astype(np.float32)


def synth_midi_audio(notes, tpq, tcs, duration):
    """Render MIDI notes to a mono PCM array via additive sine-wave synthesis.
    Uses the first 4 harmonics with 1/k amplitude weighting (sawtooth-like
    timbre) to spread energy across pitch classes, matching real audio spectra
    better than pure sinusoids.
    """
    n_samples = int(np.ceil(duration * SR))
    audio = np.zeros(n_samples, dtype=np.float32)
    t = np.arange(n_samples, dtype=np.float32) / SR
    nyquist = SR / 2.0
    N_HARMONICS = 6
    # Amplitude envelope: 10 ms attack, 20 ms release per note (cheap ADSR)
    ATK = int(0.010 * SR)
    REL = int(0.020 * SR)
    for st, et, pitch, vel in notes:
        ts = _tick_to_sec(st, tpq, tcs)
        te = _tick_to_sec(et, tpq, tcs)
        i0 = int(ts * SR)
        i1 = min(n_samples, int(te * SR) + REL)
        if i0 >= n_samples or i1 <= i0:
            continue
        amp = (vel / 127.0) * 0.15  # keep overall level modest
        f0  = 440.0 * 2.0 ** ((pitch - 69) / 12.0)
        seg = np.zeros(i1 - i0, dtype=np.float32)
        for k in range(1, N_HARMONICS + 1):
            fk = f0 * k
            if fk >= nyquist:
                break
            seg += np.float32(amp / k) * np.sin(np.float32(2.0 * np.pi * fk) * t[i0:i1])
        # Simple envelope
        env = np.ones(len(seg))
        atk_end = min(ATK, len(seg))
        env[:atk_end] = np.linspace(0.0, 1.0, atk_end)
        note_len = min(int((te - ts) * SR), len(seg))
        rel_start = max(0, note_len - REL)
        rel_end   = min(len(seg), note_len)
        if rel_end > rel_start:
            env[rel_start:rel_end] = np.linspace(1.0, 0.0, rel_end - rel_start)
        if note_len < len(seg):
            env[note_len:] = 0.0
        audio[i0:i1] += seg * env
    # Peak-normalise
    peak = np.max(np.abs(audio))
    if peak > 1e-6:
        audio /= peak
    return audio.astype(np.float32)


def dtw_band(C, band):
    """DTW with Sakoe-Chiba band using anti-diagonal vectorisation.
    C: (N, M) float32 cost matrix (will be modified in place).
    band: integer half-bandwidth in frames.
    Returns warping path ndarray (2, L).
    """
    N, M = C.shape
    D = np.full((N, M), np.inf, dtype=np.float32)
    D[0, 0] = C[0, 0]

    report_every = max(1, (N + M) // 20)
    # Anti-diagonal sweep: d = i + j ranges from 0 to N+M-2
    for d in range(1, N + M - 1):
        if d % report_every == 0:
            reportProgress(f"  DTW progress: {100 * d // (N + M)}%")
        # Row range for this anti-diagonal
        i_lo = max(0, d - M + 1)
        i_hi = min(N - 1, d)
        # Apply Sakoe-Chiba: |i - j| = |i - (d-i)| = |2i - d| <= band
        half = band
        i_lo = max(i_lo, (d - half + 1) // 1)  # j = d - i <= i + band => i >= (d-band)/2
        i_lo = max(i_lo, (d - half))             # i >= d - band (j <= band)
        i_hi = min(i_hi, d + half)               # i <= d + band (j >= -band)
        # Convert to integer range and clamp
        i_lo = int(max(i_lo, 0))
        i_hi = int(min(i_hi, N - 1))
        if i_lo > i_hi:
            continue
        rows = np.arange(i_lo, i_hi + 1, dtype=np.int32)
        cols = d - rows  # j = d - i
        # Clamp cols that may fall outside [0, M-1] due to rounding
        valid = (cols >= 0) & (cols < M)
        rows = rows[valid]
        cols = cols[valid]
        if len(rows) == 0:
            continue

        # Three predecessors: (i-1,j-1), (i-1,j), (i,j-1)
        prev_diag = np.where((rows > 0) & (cols > 0),
                             D[rows - 1, cols - 1], np.inf)
        prev_vert = np.where(rows > 0, D[rows - 1, cols], np.inf)
        prev_horiz = np.where(cols > 0, D[rows, cols - 1], np.inf)
        best = np.minimum(np.minimum(prev_diag, prev_vert), prev_horiz)
        D[rows, cols] = C[rows, cols] + best

    # Backtrack
    i, j = N - 1, M - 1
    path_i, path_j = [i], [j]
    while i > 0 or j > 0:
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            d_diag  = D[i-1, j-1]
            d_vert  = D[i-1, j]
            d_horiz = D[i, j-1]
            if d_diag <= d_vert and d_diag <= d_horiz:
                i -= 1; j -= 1
            elif d_vert <= d_horiz:
                i -= 1
            else:
                j -= 1
        path_i.append(i)
        path_j.append(j)
    path_i.reverse()
    path_j.reverse()
    return np.array([path_i, path_j])


def _dtw_f32(C):
    """Unconstrained DTW in float32 (lower memory than float64).
    Intended for small coarse cost matrices only.
    Returns warping path (2, L).
    """
    N, M = C.shape
    D = np.full((N, M), np.inf, dtype=np.float32)
    D[0, 0] = C[0, 0]
    for j in range(1, M):
        D[0, j] = D[0, j - 1] + C[0, j]
    for i in range(1, N):
        D[i, 0] = D[i - 1, 0] + C[i, 0]
    for i in range(1, N):
        for j in range(1, M):
            D[i, j] = C[i, j] + min(D[i-1, j-1], D[i-1, j], D[i, j-1])
    i, j = N - 1, M - 1
    pi, pj = [i], [j]
    while i > 0 or j > 0:
        if i == 0: j -= 1
        elif j == 0: i -= 1
        else:
            d, v, h = float(D[i-1,j-1]), float(D[i-1,j]), float(D[i,j-1])
            if d <= v and d <= h: i -= 1; j -= 1
            elif v <= h: i -= 1
            else: j -= 1
        pi.append(i); pj.append(j)
    pi.reverse(); pj.reverse()
    return np.array([pi, pj])


def _guided_band_dtw(ref_chroma, other_chroma, j_lo, j_hi):
    """Streaming band DTW guided by per-row column bounds.

    Memory profile (regardless of audio length):
      - d_prev / d_cur: two float32 rows of width M  (~70 KB for 8400 frames)
      - par: (N, max_bw) int8 parent matrix           (~1-4 MB for band ≤ 500)
      - cost vector:  (bw,) float32 per row            negligible

    The sequential left-to-right dependency within each row is handled by the
    recurrence   d_cur[k] = costs[k] + min(d_prev[j−1], d_prev[j], d_cur[k−1])
    which is computed with a vectorised "prefix min" trick to avoid O(N×bw)
    pure-Python scalar iterations.

    ref_chroma : (12, N) float32
    other_chroma: (12, M) float32
    j_lo, j_hi : (N,) int32  inclusive band col bounds per row
    Returns warping path (2, L).
    """
    N = ref_chroma.shape[1]
    M = other_chroma.shape[1]
    max_bw = int(np.max(j_hi - j_lo + 1))

    # Parent pointer matrix — 0=diag, 1=vert, 2=horiz (int8 to minimise memory)
    par = np.zeros((N, max_bw), dtype=np.int8)

    # Rolling previous / current accumulated cost (full M width; inf = not in band)
    INF = np.float32(np.inf)
    d_prev = np.full(M, INF, dtype=np.float32)

    for i in range(N):
        lo = int(j_lo[i]); hi = int(j_hi[i]); bw = hi - lo + 1

        # ── cost vector for this row's band (one fast matmul) ──────────────
        costs = np.clip(
            1.0 - ref_chroma[:, i] @ other_chroma[:, lo : hi + 1],
            0, 2
        ).astype(np.float32)                                  # (bw,)

        # ── diagonal and vertical predecessors (numpy, no loop) ────────────
        # d_prev[lo-1 : hi] for diagonal; pad with inf at the left boundary
        if lo > 0:
            diag_pred = d_prev[lo - 1 : hi]                  # (bw,)
        else:
            diag_pred = np.concatenate([[INF], d_prev[lo : hi]])   # (bw,)
        vert_pred = d_prev[lo : hi + 1]                       # (bw,)
        base = costs + np.minimum(diag_pred, vert_pred)       # best non-horiz

        # ── horizontal predecessor (sequential dep) via prefix-min trick ───
        # d_cur[k] = min(base[k], d_cur[k-1] + costs[k])
        # Let prefix[k] = cumsum(costs)[k], g[k] = d_cur[k] - prefix[k]
        # Then g[k] = min(base[k] - prefix[k], g[k-1])
        #           = min_{k'<=k}(base[k'] - prefix[k'])
        # → fully vectorisable with np.minimum.accumulate
        # float64 for the row temporaries: prefix grows to O(bw) along the
        # row, so the float32 add-back (prefix + cum_g) cancels catastrophically
        # (~1e-5 noise), which used to mis-mark parents (see below).
        prefix = np.cumsum(costs, dtype=np.float64)
        g_vals  = base.astype(np.float64) - prefix            # (bw,)
        if i == 0 and lo == 0:
            g_vals[0] = np.float64(costs[0]) - prefix[0]   # origin cell: D[0,0]=costs[0]
        cum_g   = np.minimum.accumulate(g_vals)               # (bw,)
        d_cur   = (prefix + cum_g).astype(np.float32)         # (bw,) final accumulated costs

        # Fix up the origin cell (i=0, j=0 must equal costs[0])
        if i == 0 and lo == 0:
            d_cur[0] = costs[0]

        # ── parent pointers (one numpy pass per row) ───────────────────────
        # For each k: was the horizontal option better than diag/vert?
        # "best k0 for horiz ending at k" is argmin of g_vals[0..k]
        # If cum_g[k] < g_vals[k], horiz from some k0 < k was used. Decide
        # from the cum-min's PROVENANCE, in g-space — comparing the float32
        # reconstruction (d_cur < base) decides on cancellation roundoff and
        # decoded paths costing far more than the DP optimum (found 2026-08-30
        # by spec 41's synthetic corpus; 156 mis-marked parents on one run).
        # We need the actual k0 to store correct parents but for the path we
        # only need one choice: 0=diag/vert, 2=horiz (see backtrack below).
        use_horiz = (cum_g < g_vals)                          # (bw,) bool
        # Among diag/vert: which predecessor was better? STRICT less-than so
        # exact ties prefer the diagonal — the same tie semantics as
        # dtw_band's backtrack. A non-strict compare here walks staircases
        # through zero-cost plateaus (sustained identical frames), biasing
        # the path early; real audio never ties exactly, synthetic audio does.
        use_vert  = (~use_horiz) & (vert_pred < diag_pred)
        par_row = par[i, :bw]
        par_row[:] = np.where(use_horiz, np.int8(2),
                     np.where(use_vert,  np.int8(1),
                                         np.int8(0)))
        # Origin override
        if i == 0 and lo == 0:
            par_row[0] = np.int8(3)  # start marker

        # ── update rolling prev row ────────────────────────────────────────
        if i > 0:
            old_lo = int(j_lo[i - 1]); old_hi = int(j_hi[i - 1])
            d_prev[old_lo : old_hi + 1] = INF
        d_prev[lo : hi + 1] = d_cur

    # ── Backtrack from (N-1, M-1) or nearest reachable in band ────────────
    i = N - 1
    j = min(M - 1, int(j_hi[i]))
    pi, pj = [i], [j]
    while i > 0 or j > 0:
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            lo = int(j_lo[i]); k = j - lo
            bw_i = int(j_hi[i]) - lo + 1
            if 0 <= k < bw_i:
                p = int(par[i, k])
                if p == 0 or p == 3: i -= 1; j -= 1   # diag / start
                elif p == 1: i -= 1                     # vert
                else:        j -= 1                     # horiz
            else:
                # Out-of-band fallback. With connective bands this should not
                # fire; if it ever does, clamp back under the row's ceiling so
                # one stray step cannot become a thousand-row diagonal drift.
                i -= 1; j -= 1
                if j > int(j_hi[i]):
                    j = int(j_hi[i])
        pi.append(i); pj.append(j)
    pi.reverse(); pj.reverse()
    return np.array([pi, pj])


def make_monotonic(wp):
    """Make warping path strictly monotonic."""
    # Keep last occurrence of each unique row index
    last_for_i = {}
    for k in range(wp.shape[1]):
        last_for_i[int(wp[0, k])] = k
    keep = sorted(last_for_i.values())
    wp = wp[:, keep]

    # Keep last occurrence of each unique column index
    last_for_j = {}
    for k in range(wp.shape[1]):
        last_for_j[int(wp[1, k])] = k
    keep = sorted(last_for_j.values())
    return wp[:, keep]


def align_pair(ref_chroma, other_chroma, ref_duration, other_duration):
    """Two-level memory-efficient DTW alignment.

    Level 1 — Coarse (4× pool):
      Unconstrained DTW on ~2100-frame features.
      Cost matrix: (N/4 × M/4) float32  ≈ 17 MB for 14-min recordings.
      Accumulator: same size float32     ≈ 17 MB.
      Captures global tempo drift.

    Level 2 — Fine (guided band):
      cost computed on-the-fly via dot product — no N×M cost matrix.
      Rolling d_prev row: M float32      ≈ 33 KB for 8400 frames.
      Parent matrix: (N × band) int8    ≈ 1-4 MB.
      Tight Sakoe-Chiba band derived from coarse path ± SLACK frames.
    """
    N, M = ref_chroma.shape[1], other_chroma.shape[1]

    # ── Level 1: coarse unconstrained DTW ────────────────────────────────
    rc = _pool_features(ref_chroma, COARSE)
    oc = _pool_features(other_chroma, COARSE)
    Nc, Mc = rc.shape[1], oc.shape[1]

    Cc = (1.0 - rc.T @ oc).clip(0, 2).astype(np.float32)
    del rc, oc
    wp_c = _dtw_f32(Cc)
    del Cc

    # ── Build fine-resolution per-row band bounds from coarse path ───────
    # Linearly interpolate the coarse warping path to fine frames,
    # then expand by ±SLACK to give the fine DTW room to move.
    # Map every coarse path step to fine (row_i, col_j) coordinates
    fi_pts = wp_c[0].astype(np.float32) * COARSE   # fine row
    fj_pts = wp_c[1].astype(np.float32) * COARSE   # fine col (centre of coarse block)

    # Interpolate centre column for every fine row
    if len(fi_pts) > 1:
        fj_centre = np.interp(
            np.arange(N, dtype=np.float32),
            fi_pts, fj_pts
        ).astype(np.float32)
    else:
        fj_centre = np.full(N, fj_pts[0], dtype=np.float32)

    j_lo = np.maximum(0,     (fj_centre - SLACK).astype(np.int32))
    j_hi = np.minimum(M - 1, (fj_centre + SLACK + COARSE).astype(np.int32))

    # Enforce monotonicity of band (required for streaming DTW correctness)
    for fi in range(1, N):
        if j_lo[fi] < j_lo[fi - 1]: j_lo[fi] = j_lo[fi - 1]
        if j_hi[fi] < j_hi[fi - 1]: j_hi[fi] = j_hi[fi - 1]

    del wp_c, fj_centre, fi_pts, fj_pts

    # ── Level 2: guided band streaming DTW ───────────────────────────────
    wp = _guided_band_dtw(ref_chroma, other_chroma, j_lo, j_hi)
    wp = make_monotonic(wp)

    # ── Convert frame indices → times → transfer annotation grid ─────────
    n_ref   = ref_chroma.shape[1]
    n_other = other_chroma.shape[1]
    ref_times   = wp[0].astype(np.float64) * ref_duration   / max(n_ref   - 1, 1)
    other_times = wp[1].astype(np.float64) * other_duration / max(n_other - 1, 1)

    ref_grid   = np.arange(0, ref_duration, ANNOTATION_STEP)
    transferred = interp1d(
        ref_times, other_times, kind='linear', fill_value='extrapolate'
    )(ref_grid)
    return transferred.tolist()


def compute_peaks(samples, n_peaks):
    """Downsample audio to n_peaks max-amplitude values for waveform preview.
    Divides the signal into n_peaks equal windows and takes the max abs value
    of each window.  Values are in [0, max_amp] (WaveSurfer normalises them).
    """
    n = len(samples)
    if n == 0 or n_peaks <= 0:
        return []
    n_trim = (n // n_peaks) * n_peaks
    if n_trim == 0:
        # Audio shorter than n_peaks samples — upsample by index replication
        idx = np.linspace(0, n - 1, n_peaks).astype(np.int32)
        return np.abs(samples)[idx].tolist()
    peaks = np.abs(samples[:n_trim]).reshape(n_peaks, -1).max(axis=1)
    return peaks.tolist()


# --- Streaming batch state ---
# Features are extracted one audio at a time (main thread decodes, transfers,
# worker extracts, discards raw samples) so only one raw PCM buffer is resident
# at any moment. All per-batch state lives in these module-level dicts.
_chromas = {}
_durations = {}
_peaks_data = {}
_ref_audio_copy = None
_batch_ref_name = ""
_batch_peak_count = 0
_batch_score_mode = False
_feature_count = 0
_feature_total = 0


def begin_batch(ref_name, peak_count, score_mode, feature_total):
    """Reset per-batch state at the start of a new alignment run."""
    global _chromas, _durations, _peaks_data, _ref_audio_copy
    global _batch_ref_name, _batch_peak_count, _batch_score_mode
    global _feature_count, _feature_total
    _chromas = {}
    _durations = {}
    _peaks_data = {}
    _ref_audio_copy = None
    _batch_ref_name = str(ref_name)
    _batch_peak_count = int(peak_count)
    _batch_score_mode = bool(score_mode)
    _feature_count = 0
    _feature_total = int(feature_total)
    import gc
    gc.collect()


def extract_feature(name, audio, is_ref):
    """Extract chroma (+ optional peaks) for one audio, discarding raw samples on return."""
    global _ref_audio_copy, _feature_count
    name = str(name)
    _feature_count += 1
    reportStep("features", "start", name, _feature_count, _feature_total, None)
    # Progress bar is advanced by the main thread per completed file (decode + feature
    # as one unit), so don't also move it here — only refresh the status text.
    reportProgress(
        f"Extracting features: {name} ({_feature_count}/{_feature_total})"
    )
    t0 = _time.time()
    _chromas[name] = compute_chroma(audio)
    _durations[name] = len(audio) / SR
    if _batch_peak_count > 0:
        _peaks_data[name] = compute_peaks(audio, _batch_peak_count)
    # Score alignment needs the ref audio's raw samples later; keep a copy.
    if bool(is_ref) and _batch_score_mode:
        _ref_audio_copy = np.array(audio, dtype=np.float32, copy=True)
    elapsed = _time.time() - t0
    reportStep("features", "done", name, _feature_count, _feature_total, elapsed)
    return elapsed


def align_all_from_features():
    """Build the alignment JSON from accumulated features.

    Per-pair gc.collect() frees the non-ref chroma we just consumed, keeping
    peak heap usage at ref_chroma + one other_chroma + DTW scratch.
    """
    import gc
    ref_name = _batch_ref_name
    if ref_name not in _chromas:
        raise RuntimeError(f"Reference '{ref_name}' missing from extracted features")
    ref_duration = _durations[ref_name]
    ref_grid = np.arange(0, ref_duration, ANNOTATION_STEP)
    filenames = list(_chromas.keys())
    n = len(filenames)

    result = {}
    pair_count = 0
    total_pairs = max(1, n - 1)
    for name in filenames:
        if name == ref_name:
            times = ref_grid.tolist()
        else:
            pair_count += 1
            reportStep("align", "start", name, pair_count, total_pairs, None)
            reportProgress(
                f"Aligning: {name} ({pair_count}/{total_pairs})",
                int(30 + 65 * pair_count / total_pairs)
            )
            t0 = _time.time()
            times = align_pair(
                _chromas[ref_name], _chromas[name],
                ref_duration, _durations[name]
            )
            elapsed = _time.time() - t0
            reportStep("align", "done", name, pair_count, total_pairs, elapsed)
        if _peaks_data:
            result[name] = {
                "times": times,
                "peaks": _peaks_data[name],
                "duration": round(_durations[name], 6),
            }
        else:
            result[name] = times
        # Free the non-ref chroma as soon as it's been consumed.
        if name != ref_name:
            del _chromas[name]
            gc.collect()

    reportProgress("Done!", 100)
    return {
        "header": {"ref": ref_name},
        "body": {"audio": result}
    }


def clear_batch_state():
    """Release all per-batch memory after the batch is fully consumed."""
    global _chromas, _durations, _peaks_data, _ref_audio_copy
    _chromas = {}
    _durations = {}
    _peaks_data = {}
    _ref_audio_copy = None
    import gc
    gc.collect()


# --- MIDI parsing and score alignment ---

def _read_varlen(data, pos):
    val = 0
    while True:
        b = data[pos]; pos += 1
        val = (val << 7) | (b & 0x7F)
        if not (b & 0x80):
            break
    return val, pos

def parse_midi(midi_bytes):
    """Parse a Standard MIDI File. Returns (tpq, tempo_changes, notes).
    notes: [(start_tick, end_tick, pitch, velocity), ...]
    tempo_changes: [(tick, microseconds_per_beat), ...]
    """
    import struct
    pos = 0
    if midi_bytes[pos:pos+4] != b'MThd':
        raise ValueError("Not a MIDI file")
    pos += 4
    hlen = struct.unpack('>I', midi_bytes[pos:pos+4])[0]; pos += 4
    pos += 2  # format
    n_tr = struct.unpack('>H', midi_bytes[pos:pos+2])[0]; pos += 2
    tpq  = struct.unpack('>H', midi_bytes[pos:pos+2])[0]; pos += 2
    pos  = 8 + hlen

    tempo_changes = [(0, 500000)]  # default 120 BPM
    notes = []

    for _ in range(n_tr):
        if midi_bytes[pos:pos+4] != b'MTrk':
            break
        pos += 4
        tlen = struct.unpack('>I', midi_bytes[pos:pos+4])[0]; pos += 4
        end  = pos + tlen
        tick = 0; rs = 0
        active = {}

        while pos < end:
            delta, pos = _read_varlen(midi_bytes, pos)
            tick += delta
            b = midi_bytes[pos]
            if b == 0xFF:                      # meta event
                pos += 1
                mtype = midi_bytes[pos]; pos += 1
                mlen, pos = _read_varlen(midi_bytes, pos)
                if mtype == 0x51 and mlen == 3:
                    uspb = struct.unpack('>I', b'\\x00' + bytes(midi_bytes[pos:pos+3]))[0]
                    tempo_changes.append((tick, uspb))
                pos += mlen
            elif b in (0xF0, 0xF7):            # sysex
                pos += 1
                slen, pos = _read_varlen(midi_bytes, pos)
                pos += slen
            else:
                if b & 0x80: rs = b; pos += 1
                kind = rs >> 4; ch = rs & 0xF
                if kind == 0x9:
                    p = midi_bytes[pos]; pos += 1
                    v = midi_bytes[pos]; pos += 1
                    if v > 0:
                        active[(ch, p)] = (tick, v)
                    else:
                        if (ch, p) in active:
                            st, sv = active.pop((ch, p))
                            notes.append((st, tick, p, sv))
                elif kind == 0x8:
                    p = midi_bytes[pos]; pos += 1
                    pos += 1  # velocity ignored for note-off
                    if (ch, p) in active:
                        st, sv = active.pop((ch, p))
                        notes.append((st, tick, p, sv))
                elif kind in (0xA, 0xB, 0xE): pos += 2
                elif kind in (0xC, 0xD):      pos += 1

        # Close notes still open at end of track
        for (ch, p), (st, sv) in active.items():
            notes.append((st, tick, p, sv))
        pos = end

    # Sort by tick ONLY (stable): a bare tuple sort breaks the tick-0 tie by
    # tempo VALUE, which put the seeded 500000 default AFTER a real tempo
    # event at tick 0 — and _tick_to_sec lets the last same-tick entry win,
    # so the default 120 BPM silently overrode the file's opening tempo.
    tempo_changes.sort(key=lambda t: t[0])
    notes.sort()
    return tpq, tempo_changes, notes

def _tick_to_sec(tick, tpq, tcs):
    secs = 0.0; pt = 0; pu = 500000
    for ct, cu in tcs:
        if ct >= tick: break
        secs += (ct - pt) / tpq * pu / 1e6
        pt = ct; pu = cu
    return secs + (tick - pt) / tpq * pu / 1e6

def score_align(midi_bytes_py, ref_audio, mei_uri):
    """
    Align MIDI score to reference audio via multi-resolution chroma DTW.

    Pipeline:
      1. Parse SMF MIDI → notes + complete tempo map
      2. Synthesise to mono PCM (additive sine harmonics) — puts synth and
         real audio in the same STFT feature space
      3. Extract STFT chroma (SCORE_N_FFT) and spectral-flux onset strength
         (ONSET_N_FFT, finer window) for both synth and reference
      4. Scale each chroma frame by (1 + ONSET_WEIGHT * onset), renormalise
         → attack moments dominate the cost matrix, stabilising alignment
         for ensemble music (approximates DLNCO onset weighting)
      5. Coarse DTW: pool features by SCORE_DOWNSAMPLE (=> ~5 Hz),
         run fully unconstrained DTW on the small matrix.  This captures
         global structure — the essential fix for the 'random' failure mode
         that plagued a single-level SC-band approach.
      6. Map each deduplicated note onset/offset through the coarse warping
         path via linear interpolation → final score-to-audio alignment.

    Returns dict: score_onset, ref_onset, score_offset, ref_offset
    (score times in quarter-notes; ref times in seconds).
    """
    t0_total = _time.time()
    reportStep("score", "start", "Score alignment", None, None, None)

    reportProgress("Score alignment: parsing MIDI...", None)
    tpq, tcs, notes = parse_midi(midi_bytes_py)
    if not notes:
        reportStep("score", "done", "Score alignment", None, None, 0.0)
        return None

    max_tick = max(n[1] for n in notes)
    midi_dur = _tick_to_sec(max_tick, tpq, tcs) + 0.5
    ref_dur  = len(ref_audio) / SR

    reportProgress("Score alignment: synthesising MIDI audio...", None)
    synth_audio = synth_midi_audio(notes, tpq, tcs, midi_dur)

    reportProgress("Score alignment: extracting chroma features...", None)
    sc = compute_chroma_score(synth_audio)
    rc = compute_chroma_score(ref_audio)

    reportProgress("Score alignment: extracting onset features...", None)
    sc_onset = compute_onset_strength(synth_audio)
    del synth_audio
    rc_onset = compute_onset_strength(ref_audio)

    # Trim/pad onset arrays to match chroma frame count
    n_sc = sc.shape[1];  n_rc = rc.shape[1]
    sc_onset = sc_onset[:n_sc] if len(sc_onset) >= n_sc else np.pad(sc_onset, (0, n_sc - len(sc_onset)))
    rc_onset = rc_onset[:n_rc] if len(rc_onset) >= n_rc else np.pad(rc_onset, (0, n_rc - len(rc_onset)))

    # Onset-weighted chroma features
    sc_feat = build_score_features(sc, sc_onset)
    rc_feat = build_score_features(rc, rc_onset)
    del sc, rc, sc_onset, rc_onset

    # --- Coarse DTW (unconstrained) on downsampled features ---
    reportProgress("Score alignment: coarse DTW...", None)
    sc_c = _pool_features(sc_feat, SCORE_DOWNSAMPLE)
    rc_c = _pool_features(rc_feat, SCORE_DOWNSAMPLE)
    del sc_feat, rc_feat   # no fine-DTW pass needed
    n_sc_c = sc_c.shape[1]
    n_rc_c = rc_c.shape[1]

    C_c = (np.float32(1.0) - sc_c.T @ rc_c).astype(np.float32)
    np.clip(C_c, 0, 2, out=C_c)
    del sc_c, rc_c
    # Pass band=max(shape) to dtw_band → effectively unconstrained
    wp_c = make_monotonic(dtw_band(C_c, max(C_c.shape)))
    del C_c

    # Coarse path → time mapping (each frame spans SCORE_DOWNSAMPLE * SCORE_HOP seconds)
    sc_times_c = wp_c[0].astype(np.float64) * midi_dur / max(n_sc_c - 1, 1)
    rc_times_c = wp_c[1].astype(np.float64) * ref_dur  / max(n_rc_c - 1, 1)
    del wp_c
    wf = interp1d(sc_times_c, rc_times_c, kind='linear', fill_value='extrapolate')

    # Deduplicate chord notes: one entry per unique (onset_tick, offset_tick)
    seen = {}
    for st, et, pitch, vel in sorted(notes, key=lambda x: (x[0], x[1])):
        if (st, et) not in seen:
            seen[(st, et)] = vel

    s_on = []; r_on = []; s_off = []; r_off = []; s_on_sec = []; s_off_sec = []
    for (st, et), vel in sorted(seen.items()):
        t_on  = _tick_to_sec(st, tpq, tcs)
        t_off = _tick_to_sec(et, tpq, tcs)
        s_on.append(st  / tpq)
        s_off.append(et / tpq)
        s_on_sec.append(t_on)   # MIDI-derived seconds = position in synthesised audio
        s_off_sec.append(t_off)
        r_on.append(float(np.clip(wf(t_on),  0.0, ref_dur)))
        r_off.append(float(np.clip(wf(t_off), 0.0, ref_dur)))

    elapsed = _time.time() - t0_total
    reportStep("score", "done", "Score alignment", None, None, elapsed)
    return {
        "score_onset":  s_on,
        "ref_onset":    r_on,
        "score_offset": s_off,
        "ref_offset":   r_off,
        "synth_onset":  s_on_sec,   # listen.js uses these to build the synth waveform’s alignment grid
        "synth_offset": s_off_sec,
    }


# --- Fix-mode (hand-correction) session — plan section 14, increment 1 ---
#
# The alignment-correction UI pins ANCHORS (score event <-> reference time)
# and re-fills only the events BETWEEN neighbouring anchors. The reference
# audio and the score's parsed + synthesised form stay resident so each
# refill re-runs DTW only on its segment, at a hop that ADAPTS to the
# segment length: short segments get finer frames than the original
# full-piece alignment (FIX_MIN_HOP ~23 ms vs SCORE_HOP 100 ms), while a
# full-piece segment lands back near the original resolution via the
# FIX_MAX_FRAMES cap. The band follows the STORED mapping (tapered onto the
# anchor endpoints), so far from a fix the refill snaps back to the old
# path — anchors bend the alignment locally, they never reshuffle it.

FIX_MIN_HOP = 512        # samples (~23 ms) — floor for short segments
FIX_MAX_FRAMES = 6000    # frame cap; full piece lands near SCORE_HOP
FIX_SLACK_SEC = 4.0      # default band half-width around the prior map

_fix = None

def fix_begin(ref_audio, midi_bytes_py):
    """Bootstrap a correction session: parse + synthesise the score once and
    keep both PCM arrays resident. Returns the deduplicated event table —
    the SAME construction as score_align — so the client can run the item-T
    quarters guard against the stored score_onset before any editing."""
    global _fix
    tpq, tcs, notes = parse_midi(midi_bytes_py)
    if not notes:
        raise RuntimeError('fix_begin: MIDI contains no notes')
    max_tick = max(n[1] for n in notes)
    midi_dur = _tick_to_sec(max_tick, tpq, tcs) + 0.5
    reportProgress('Correction session: synthesising score audio...', None)
    synth_audio = synth_midi_audio(notes, tpq, tcs, midi_dur)
    ref = np.asarray(ref_audio, dtype=np.float32)
    seen = {}
    for st, et, pitch, vel in sorted(notes, key=lambda x: (x[0], x[1])):
        if (st, et) not in seen:
            seen[(st, et)] = vel
    q_on = []; q_off = []; s_on_sec = []; s_off_sec = []
    for (st, et), vel in sorted(seen.items()):
        q_on.append(st / tpq)
        q_off.append(et / tpq)
        s_on_sec.append(_tick_to_sec(st, tpq, tcs))
        s_off_sec.append(_tick_to_sec(et, tpq, tcs))
    _fix = {
        'ref': ref,
        'synth': synth_audio,
        'ref_dur': len(ref) / SR,
        'midi_dur': midi_dur,
        's_on': np.array(s_on_sec, dtype=np.float64),
        's_off': np.array(s_off_sec, dtype=np.float64),
    }
    return {
        'score_onset': q_on,
        'score_offset': q_off,
        'synth_onset': s_on_sec,
        'synth_offset': s_off_sec,
        'n_events': len(q_on),
        'ref_duration': _fix['ref_dur'],
        'midi_duration': midi_dur,
    }

def _fix_features(audio, lo_sec, hi_sec, hop):
    """Onset-weighted chroma for one audio slice at the segment's hop."""
    lo = max(0, int(lo_sec * SR))
    hi = min(len(audio), int(hi_sec * SR))
    seg = audio[lo:hi]
    ch = compute_chroma(seg, n_fft=SCORE_N_FFT, hop=hop)
    on = compute_onset_strength(seg, hop=hop)
    n = ch.shape[1]
    on = on[:n] if len(on) >= n else np.pad(on, (0, n - len(on)))
    return build_score_features(ch, on)

def fix_realign_segment(i_a, t_a, i_b, t_b, prior_ref, slack_sec=None, max_frames=None):
    """Re-fill ref onsets/offsets for the events strictly between two anchors.

    i_a / i_b: bounding event indices (-1 = piece-start corner, n_events =
    piece-end corner); t_a / t_b: their (corrected) reference times.
    prior_ref: the CURRENT ref_onset values of the interior events, used as
    the DTW guide band's centre (tapered onto the anchors, +- slack_sec).
    Returns interior ref_onset / ref_offset, the anchor event i_a's remapped
    offset when it falls inside the segment, and the hop actually used.
    """
    if _fix is None:
        raise RuntimeError('fix_realign_segment before fix_begin')
    slack = FIX_SLACK_SEC if slack_sec is None else float(slack_sec)
    cap = FIX_MAX_FRAMES if max_frames is None else int(max_frames)
    s_on = _fix['s_on']; s_off = _fix['s_off']
    n_ev = len(s_on)
    i_a = int(i_a); i_b = int(i_b)
    if not (-1 <= i_a < i_b <= n_ev):
        raise ValueError('fix_realign_segment: bad segment indices')
    s_a = 0.0 if i_a < 0 else float(s_on[i_a])
    s_b = _fix['midi_dur'] if i_b >= n_ev else float(s_on[i_b])
    t_a = float(t_a); t_b = float(t_b)
    if not (t_b > t_a and s_b > s_a):
        raise ValueError('fix_realign_segment: empty or reversed segment span')
    interior = list(range(i_a + 1, i_b))
    if len(prior_ref) != len(interior):
        raise ValueError('fix_realign_segment: prior_ref length mismatch')
    if not interior:
        return {'ref_onset': [], 'ref_offset': [], 'anchor_a_offset': None, 'hop': 0}

    # Hop adapts to the segment: fine frames when short, capped for length.
    seg_s = s_b - s_a; seg_r = t_b - t_a
    hop = max(FIX_MIN_HOP, int(np.ceil(max(seg_s, seg_r) * SR / cap)))
    feat_s = _fix_features(_fix['synth'], s_a, s_b, hop)
    feat_r = _fix_features(_fix['ref'], t_a, t_b, hop)
    n_s = feat_s.shape[1]; n_r = feat_r.shape[1]
    if n_s < 2 or n_r < 2:
        raise ValueError('fix_realign_segment: segment too short to align')

    # Guide band centre: the stored interior mapping, endpoints forced onto
    # the anchors, made monotonic and clipped so garbage stored values can
    # only cost band width, never break the DTW's preconditions.
    ks = np.array([s_a] + [float(s_on[i]) for i in interior] + [s_b], dtype=np.float64)
    kr = np.array([t_a] + [float(v) for v in prior_ref] + [t_b], dtype=np.float64)
    kr = np.maximum.accumulate(np.clip(kr, t_a, t_b))
    ks, first_ix = np.unique(ks, return_index=True)
    kr = kr[first_ix]

    s_times = s_a + np.arange(n_s, dtype=np.float64) * seg_s / max(n_s - 1, 1)
    centre_r = np.interp(s_times, ks, kr)
    centre_f = (centre_r - t_a) * (n_r - 1) / seg_r
    slack_f = max(8, int(np.ceil(slack * (n_r - 1) / seg_r)))
    j_lo = np.clip((centre_f - slack_f).astype(np.int32), 0, n_r - 1)
    j_hi = np.minimum(n_r - 1, (centre_f + slack_f).astype(np.int32))
    j_lo[0] = 0
    j_lo = np.maximum.accumulate(j_lo)
    j_hi = np.maximum.accumulate(j_hi)
    j_hi[-1] = n_r - 1
    j_hi = np.maximum(j_hi, j_lo)  # never an empty row band
    # CONNECTIVITY: where the prior map jumps by more than the slack (a stored
    # discontinuity — e.g. an unscored-audio artifact zone), the band would
    # otherwise be DISJOINT between adjacent rows, severing the DP: every cell
    # downstream of the jump accumulates inf, parents there are meaningless,
    # and the backtrack walks out of band (found 2026-08-31 on the Fledermaus
    # HQ corpus: a first-onset fix mapped the whole opening ~55 s late).
    # Bridging the floor to the previous ceiling + 1 keeps every row reachable,
    # so the DTW genuinely traverses the jump instead of silently breaking.
    # min of two non-decreasing sequences, so j_lo stays non-decreasing.
    j_lo[1:] = np.minimum(j_lo[1:], j_hi[:-1] + 1)

    wp = make_monotonic(_guided_band_dtw(feat_s, feat_r, j_lo, j_hi))
    s_path = s_a + wp[0].astype(np.float64) * seg_s / max(n_s - 1, 1)
    r_path = t_a + wp[1].astype(np.float64) * seg_r / max(n_r - 1, 1)
    wf = interp1d(s_path, r_path, kind='linear', fill_value='extrapolate')

    # An OFFSET may legitimately lie past the segment's right edge: ties,
    # sustained notes under a moving line, any polyphonic overlap. On the
    # Fledermaus HQ corpus 33.5% of events sustain past the next DISTINCT
    # onset; of the events an anchor is actually laid on (a group's first),
    # 8.3% of onset groups do so at adjacent-anchor spacing and 0.7% two
    # groups on, which is where THIS function computes the offset rather than
    # the client's linear fill. Such an offset has no image under this
    # segment's warp, and both earlier answers were wrong: clipping it to t_b
    # truncated the note, and returning None for the anchor's own offset left
    # it STALE — a rightward drag could then leave offset <= onset, which the
    # synth renders as an almost inaudible 20 ms blip (the "dropped first
    # note"). Continue at the segment's average rate instead: monotone with
    # the anchors, never degenerate, capped by the recording.
    seg_rate = seg_r / seg_s

    def _map_off(s):
        s = float(s)
        if s <= s_b:
            return float(np.clip(wf(s), t_a, t_b))
        return float(min(t_b + (s - s_b) * seg_rate, _fix['ref_dur']))

    new_on  = [float(np.clip(wf(float(s_on[i])),  t_a, t_b)) for i in interior]
    new_off = [_map_off(s_off[i]) for i in interior]
    anchor_a_offset = _map_off(s_off[i_a]) if i_a >= 0 else None
    return {
        'ref_onset': new_on,
        'ref_offset': new_off,
        'anchor_a_offset': anchor_a_offset,
        'hop': hop,
    }

def fix_dispose():
    """Release the correction session's resident audio."""
    global _fix
    _fix = None
    import gc
    gc.collect()
`;

/* --- Pyodide lifecycle --- */

let pyodideReady = null;

async function initPyodide() {
  reportProgress("Loading Python runtime...", 0);
  const pyodide = await loadPyodide();
  reportProgress(
    "Installing numpy and scipy (first load may take a moment)...",
    3,
  );
  await pyodide.loadPackage(["numpy", "scipy"]);
  reportProgress("Initializing alignment engine...", 8);
  await pyodide.runPythonAsync(PYTHON_CODE);
  return pyodide;
}

/* --- Message handler --- */

/* Streaming message protocol:
 *
 *   main → worker: "begin_batch" { refName, peakCount, scoreMode, featureTotal, options }
 *   worker → main: "batch_ready"
 *
 *   (for each audio)
 *   main → worker: "feature" { name, samples, isRef }   (samples transferred)
 *   worker → main: "feature_done" { name }
 *
 *   main → worker: "align_all" { meiMidi, meiUri }
 *   worker → main: "result" { alignment }
 *
 * Fix-mode (alignment-correction) protocol — plan §14, increment 1:
 *
 *   main → worker: "fix_begin" { refSamples, meiMidi, options }  (samples transferred)
 *   worker → main: "fix_ready" { events }   (the item-T quarters-guard table)
 *
 *   (per correction)
 *   main → worker: "fix_realign" { iA, tA, iB, tB, priorRef, slackSec?, maxFrames? }
 *   worker → main: "fix_segment" { iA, iB, result: { ref_onset, ref_offset,
 *                                  anchor_a_offset, hop } }
 *
 *   main → worker: "fix_dispose"
 *   worker → main: "fix_disposed"
 *
 *   (errors at any point) worker → main: "error" { message }
 *
 * Memory discipline: raw PCM is decoded on the main thread, transferred once,
 * copied into numpy inside extract_feature, then discarded before the next
 * file's samples arrive. Chroma features (small) accumulate until align_all.
 */
self.onmessage = async function (e) {
  try {
    if (e.data.type === "begin_batch") {
      if (!pyodideReady) pyodideReady = initPyodide();
      const pyodide = await pyodideReady;

      const {
        refName,
        peakCount,
        scoreMode,
        featureTotal,
        options,
      } = e.data;

      const opts = options || {};
      pyodide.globals.set("_opt_coarse", opts.coarse ?? 0);
      pyodide.globals.set("_opt_slack", opts.slack ?? 0);
      pyodide.globals.set("_opt_feature_rate", opts.featureRate ?? 0);
      pyodide.globals.set("_opt_score_downsample", opts.scoreDownsample ?? 0);
      pyodide.globals.set("_opt_onset_weight", opts.onsetWeight ?? -1);
      pyodide.globals.set("_ref_name_arg", refName);
      pyodide.globals.set("_peak_count_arg", peakCount || 0);
      pyodide.globals.set("_score_mode_arg", !!scoreMode);
      pyodide.globals.set("_feature_total_arg", featureTotal || 0);

      await pyodide.runPythonAsync(`
_apply_options()
begin_batch(
    str(_ref_name_arg),
    int(_peak_count_arg),
    bool(_score_mode_arg),
    int(_feature_total_arg),
)
`);
      self.postMessage({ type: "batch_ready" });
      return;
    }

    if (e.data.type === "feature") {
      const pyodide = await pyodideReady;
      const { name, samples, isRef } = e.data;
      pyodide.globals.set("_feature_name", name);
      pyodide.globals.set("_feature_data", samples);
      pyodide.globals.set("_feature_is_ref", !!isRef);
      await pyodide.runPythonAsync(`
_audio_arr = np.frombuffer(_feature_data.to_py(), dtype=np.float32).copy()
extract_feature(str(_feature_name), _audio_arr, bool(_feature_is_ref))
del _audio_arr
del globals()['_feature_data']
import gc
gc.collect()
`);
      self.postMessage({ type: "feature_done", name });
      return;
    }

    if (e.data.type === "align_all") {
      const pyodide = await pyodideReady;
      const { meiMidi, meiUri } = e.data;
      pyodide.globals.set("_has_mei_arg", !!(meiMidi && meiMidi.length > 0));
      if (meiMidi && meiMidi.length > 0) {
        pyodide.globals.set("_midi_bytes_arg", meiMidi);
        pyodide.globals.set("_mei_uri_arg", meiUri || "");
      }
      const resultJson = await pyodide.runPythonAsync(`
import json

result = align_all_from_features()

if bool(_has_mei_arg) and _ref_audio_copy is not None:
    midi_bytes_py = bytes(_midi_bytes_arg.to_py())
    score_data = score_align(midi_bytes_py, _ref_audio_copy, str(_mei_uri_arg))
    if score_data:
        result["body"]["score"] = score_data
        result["header"]["meiUri"] = str(_mei_uri_arg)
    del midi_bytes_py

clear_batch_state()
json.dumps(result)
`);
      self.postMessage({
        type: "result",
        alignment: JSON.parse(resultJson),
      });
      return;
    }

    if (e.data.type === "fix_begin") {
      if (!pyodideReady) pyodideReady = initPyodide();
      const pyodide = await pyodideReady;
      const { refSamples, meiMidi, options } = e.data;
      const opts = options || {};
      pyodide.globals.set("_opt_coarse", opts.coarse ?? 0);
      pyodide.globals.set("_opt_slack", opts.slack ?? 0);
      pyodide.globals.set("_opt_feature_rate", opts.featureRate ?? 0);
      pyodide.globals.set("_opt_score_downsample", opts.scoreDownsample ?? 0);
      pyodide.globals.set("_opt_onset_weight", opts.onsetWeight ?? -1);
      pyodide.globals.set("_fix_ref_data", refSamples);
      pyodide.globals.set("_fix_midi_arg", meiMidi);
      const eventsJson = await pyodide.runPythonAsync(`
import json
_apply_options()
_fix_ref_arr = np.frombuffer(_fix_ref_data.to_py(), dtype=np.float32).copy()
_fix_midi_bytes = bytes(_fix_midi_arg.to_py())
_fix_events = fix_begin(_fix_ref_arr, _fix_midi_bytes)
del _fix_ref_arr, _fix_midi_bytes
del globals()['_fix_ref_data']
import gc
gc.collect()
json.dumps(_fix_events)
`);
      self.postMessage({ type: "fix_ready", events: JSON.parse(eventsJson) });
      return;
    }

    if (e.data.type === "fix_realign") {
      const pyodide = await pyodideReady;
      const { iA, tA, iB, tB, priorRef, slackSec, maxFrames } = e.data;
      pyodide.globals.set(
        "_fix_seg_arg",
        JSON.stringify({ iA, tA, iB, tB, priorRef, slackSec, maxFrames }),
      );
      const segJson = await pyodide.runPythonAsync(`
import json
_seg = json.loads(str(_fix_seg_arg))
json.dumps(fix_realign_segment(
    _seg['iA'], _seg['tA'], _seg['iB'], _seg['tB'],
    _seg['priorRef'], _seg.get('slackSec'), _seg.get('maxFrames'),
))
`);
      self.postMessage({ type: "fix_segment", iA, iB, result: JSON.parse(segJson) });
      return;
    }

    if (e.data.type === "fix_dispose") {
      const pyodide = await pyodideReady;
      await pyodide.runPythonAsync("fix_dispose()");
      self.postMessage({ type: "fix_disposed" });
      return;
    }
  } catch (err) {
    self.postMessage({
      type: "error",
      message: err.toString(),
    });
  }
};
