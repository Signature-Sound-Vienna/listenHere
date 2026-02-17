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

const PYTHON_CODE = `
import numpy as np
from scipy.signal import stft
from scipy.interpolate import interp1d
from js import reportProgress

SR = 22050
FEATURE_RATE = 10   # Hz — keeps DTW matrices manageable
HOP = SR // FEATURE_RATE   # 2205 samples
N_FFT = 4096
ANNOTATION_STEP = 0.02   # seconds (50 Hz output grid)


def compute_chroma(audio):
    """Compute 12-bin chroma features from audio using STFT."""
    f, t, Zxx = stft(audio, fs=SR, nperseg=N_FFT, noverlap=N_FFT - HOP)
    mag = np.abs(Zxx)

    # Only use frequency bins above 50 Hz
    valid = f > 50
    freqs = f[valid]
    mag_valid = mag[valid, :]

    # Map each frequency bin to a pitch class (0-11)
    midi = 69.0 + 12.0 * np.log2(freqs / 440.0)
    pitch_class = np.round(midi).astype(int) % 12

    # Accumulate energy per pitch class
    chroma = np.zeros((12, mag_valid.shape[1]), dtype=np.float64)
    for pc in range(12):
        mask = pitch_class == pc
        if np.any(mask):
            chroma[pc] = mag_valid[mask].sum(axis=0)

    # L2 normalize each frame
    norms = np.linalg.norm(chroma, axis=0, keepdims=True)
    norms[norms < 1e-8] = 1.0
    chroma /= norms

    return chroma   # shape (12, n_frames)


def dtw(C):
    """Standard DTW on cost matrix C (N x M). Returns warping path (2, L)."""
    N, M = C.shape
    D = np.full((N, M), np.inf, dtype=np.float64)
    D[0, 0] = C[0, 0]

    # First row
    for j in range(1, M):
        D[0, j] = D[0, j - 1] + C[0, j]
    # First column
    for i in range(1, N):
        D[i, 0] = D[i - 1, 0] + C[i, 0]

    # Fill matrix
    report_every = max(1, N // 20)
    for i in range(1, N):
        if i % report_every == 0:
            reportProgress(f"  DTW progress: {100 * i // N}%")
        for j in range(1, M):
            D[i, j] = C[i, j] + min(D[i-1, j-1], D[i-1, j], D[i, j-1])

    # Backtrack (prefer diagonal moves for temporal consistency)
    i, j = N - 1, M - 1
    path_i, path_j = [i], [j]
    while i > 0 or j > 0:
        if i == 0:
            j -= 1
        elif j == 0:
            i -= 1
        else:
            d = D[i-1, j-1]
            v = D[i-1, j]
            h = D[i, j-1]
            if d <= v and d <= h:
                i -= 1; j -= 1
            elif v <= h:
                i -= 1
            else:
                j -= 1
        path_i.append(i)
        path_j.append(j)

    path_i.reverse()
    path_j.reverse()
    return np.array([path_i, path_j])


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
    """Align two recordings via chroma DTW. Returns transferred annotations."""
    # Cost matrix: cosine distance (= 1 - dot product for L2-normalized vectors)
    C = 1.0 - ref_chroma.T @ other_chroma
    np.clip(C, 0, 2, out=C)
    C = C.astype(np.float32)

    # DTW
    wp = dtw(C)
    del C   # free memory before backtrack result is used
    wp = make_monotonic(wp)

    # Convert frame indices to times
    n_ref = ref_chroma.shape[1]
    n_other = other_chroma.shape[1]
    ref_times = wp[0].astype(np.float64) * ref_duration / max(n_ref - 1, 1)
    other_times = wp[1].astype(np.float64) * other_duration / max(n_other - 1, 1)

    # Transfer isochronous reference annotations to other recording
    ref_grid = np.arange(0, ref_duration, ANNOTATION_STEP)
    transferred = interp1d(
        ref_times, other_times, kind='linear', fill_value='extrapolate'
    )(ref_grid)
    return transferred.tolist()


def bulk_align(audio_dict, ref_name):
    """
    Align multiple recordings to a reference.
    audio_dict: {filename: np.array of float32 samples at 22050 Hz}
    ref_name: filename of the reference recording
    Returns: alignment JSON structure
    """
    filenames = list(audio_dict.keys())
    n = len(filenames)

    # Extract chroma features
    chromas = {}
    durations = {}
    for i, name in enumerate(filenames):
        reportProgress(f"Extracting features: {name} ({i+1}/{n})",
                       int(10 + 20 * i / n))
        audio = audio_dict[name]
        chromas[name] = compute_chroma(audio)
        durations[name] = len(audio) / SR

    # Free raw audio to save memory
    del audio_dict

    # Reference isochronous grid
    ref_duration = durations[ref_name]
    ref_grid = np.arange(0, ref_duration, ANNOTATION_STEP)

    # Align each recording to the reference
    result = {}
    pair_count = 0
    total_pairs = max(1, n - 1)
    for name in filenames:
        if name == ref_name:
            result[name] = ref_grid.tolist()
        else:
            pair_count += 1
            reportProgress(
                f"Aligning: {name} ({pair_count}/{total_pairs})",
                int(30 + 65 * pair_count / total_pairs)
            )
            result[name] = align_pair(
                chromas[ref_name], chromas[name],
                ref_duration, durations[name]
            )

    reportProgress("Done!", 100)
    return {
        "header": {"ref": ref_name},
        "body": {"audio": result}
    }
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

self.onmessage = async function (e) {
  if (e.data.type === "align") {
    try {
      if (!pyodideReady) pyodideReady = initPyodide();
      const pyodide = await pyodideReady;

      const { audios, refName } = e.data;
      // audios: [{name: string, samples: Float32Array}, ...]

      // Pass each audio buffer to Python globals
      for (let i = 0; i < audios.length; i++) {
        pyodide.globals.set("_audio_name_" + i, audios[i].name);
        pyodide.globals.set("_audio_data_" + i, audios[i].samples);
      }
      pyodide.globals.set("_n_audios", audios.length);
      pyodide.globals.set("_ref_name", refName);

      // Run alignment in Python
      const resultJson = await pyodide.runPythonAsync(`
import json
import numpy as np

# Build audio dict from JS globals
audio_dict = {}
for i in range(int(_n_audios)):
    name = str(globals()[f'_audio_name_{i}'])
    data_proxy = globals()[f'_audio_data_{i}']
    audio_dict[name] = np.frombuffer(data_proxy.to_py(), dtype=np.float32).copy()
    del globals()[f'_audio_name_{i}']
    del globals()[f'_audio_data_{i}']

result = bulk_align(audio_dict, str(_ref_name))
del audio_dict
json.dumps(result)
`);

      self.postMessage({
        type: "result",
        alignment: JSON.parse(resultJson),
      });
    } catch (err) {
      self.postMessage({
        type: "error",
        message: err.toString(),
      });
    }
  }
};
