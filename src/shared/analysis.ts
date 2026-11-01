// Tempo and key detection from decoded audio. Pure functions over a mono signal, so they run in
// the analyzer page (after Chromium decodes the file) and in tests alike.
//
// Tempo: spectral-flux onset envelope -> comb autocorrelation over 60-200 BPM -> fine search at
// fractional periods. Loops whose length is a whole number of bars snap to that exact tempo.
// Key: chromagram -> correlation with major/minor key profiles. One-shots (an 808, a stab) get
// their root note instead, written like a major key ("F").

/** Bump when the algorithms change, so the library is re-analyzed. */
export const ANALYSIS_VERSION = 1

/** Below these confidences a detected value is shown but not filled in automatically. */
export const APPLY_BPM_CONFIDENCE = 0.35
export const APPLY_KEY_CONFIDENCE = 0.3

/** Files are decoded at this rate for analysis: plenty for rhythm and pitch, and fast. */
export const ANALYSIS_SAMPLE_RATE = 11025

export interface AnalysisRequest {
  bpm: boolean
  key: boolean
  /** Short single sound: report its note rather than a key. */
  oneShot: boolean
  /** Full length of the file in seconds (the signal may be cut short). */
  durationSec: number
}

export interface AnalysisResult {
  bpm: number | null
  bpmConfidence: number
  key: string | null
  keyConfidence: number
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** Drum types that are single hits: no tempo to find, and no key (except an 808's note). */
const ONE_SHOT_DRUMS: Array<string | null> = ['kick', 'snare', 'clap', 'hihat_closed', 'hihat_open', '808', 'perc', 'cymbal']

/** What's worth working out for a file, or null for nothing. */
export function planAnalysis(f: { category: string; subtype: string | null; durationMs: number }): AnalysisRequest | null {
  const sec = f.durationMs / 1000
  if (sec < 0.2 || sec > 15 * 60) return null
  const drumHit = f.category === 'drum' && (ONE_SHOT_DRUMS.includes(f.subtype) || (f.subtype == null && sec < 1.5))
  const bpm = !drumHit && sec >= 1.5
  const key = f.category !== 'drum' || f.subtype === '808'
  if (!bpm && !key) return null
  return { bpm, key, oneShot: sec < 2.5, durationSec: sec }
}

// ---------- FFT ----------

/** In-place radix-2 FFT; length must be a power of two. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1
    const ang = (-2 * Math.PI) / len
    for (let k = 0; k < half; k++) {
      const wr = Math.cos(ang * k)
      const wi = Math.sin(ang * k)
      for (let i = k; i < n; i += len) {
        const j = i + half
        const tr = re[j] * wr - im[j] * wi
        const ti = re[j] * wi + im[j] * wr
        re[j] = re[i] - tr
        im[j] = im[i] - ti
        re[i] += tr
        im[i] += ti
      }
    }
  }
}

const hann = (n: number): Float64Array => Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n))

/** Magnitude spectra of overlapping frames (zero-padded past the end of the signal). */
function* spectra(x: Float32Array, size: number, hop: number): Generator<Float64Array> {
  const win = hann(size)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  const frames = Math.max(1, Math.ceil((x.length - size) / hop) + 1)
  for (let f = 0; f < frames; f++) {
    const start = f * hop
    for (let i = 0; i < size; i++) {
      const s = start + i
      re[i] = s < x.length ? x[s] * win[i] : 0
      im[i] = 0
    }
    fft(re, im)
    const mag = new Float64Array(size / 2)
    for (let k = 0; k < size / 2; k++) mag[k] = Math.hypot(re[k], im[k])
    yield mag
  }
}

const nextPow2 = (n: number): number => 2 ** Math.round(Math.log2(n))

function rms(x: Float32Array): number {
  let s = 0
  for (let i = 0; i < x.length; i++) s += x[i] * x[i]
  return Math.sqrt(s / Math.max(1, x.length))
}

// ---------- tempo ----------

/** Remove the slowly moving average so sustained loud parts don't look like beats. */
function highPass(raw: number[], fps: number): Float64Array {
  const w = Math.max(1, Math.round(fps * 0.25))
  const out = new Float64Array(raw.length)
  for (let i = 0; i < raw.length; i++) {
    let s = 0
    let n = 0
    for (let j = Math.max(0, i - w); j <= Math.min(raw.length - 1, i + w); j++) {
      s += raw[j]
      n++
    }
    out[i] = Math.max(0, raw[i] - s / n)
  }
  return out
}

/**
 * How strongly something new starts in each frame (positive spectral change).
 * `env` is log-compressed, so quiet hats count nearly as much as kicks: good for finding the
 * pulse. `accent` keeps the dynamics, so loud beats stand out: used to pick half/double time.
 */
export function onsetEnvelope(x: Float32Array, sr: number): { env: Float64Array; accent: Float64Array; fps: number } {
  const size = nextPow2(sr * 0.093)
  const hop = size / 8
  // Level-independent: scale to the peak so a full-scale partial is ~1 per bin, and the
  // compression below treats anything ~40 dB down as noise rather than detail.
  let peak = 0
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]))
  const scale = peak > 0 ? 4 / (size * peak) : 0
  const logFlux: number[] = []
  const linFlux: number[] = []
  let prevLog: Float64Array | null = null
  let prevLin: Float64Array | null = null
  for (const mag of spectra(x, size, hop)) {
    const lin = mag.map((m) => m * scale)
    const log = lin.map((m) => Math.log1p(100 * m))
    let fl = 0
    let fa = 0
    if (prevLog && prevLin) {
      for (let k = 1; k < log.length; k++) {
        fl += Math.max(0, log[k] - prevLog[k])
        fa += Math.max(0, lin[k] - prevLin[k])
      }
    }
    logFlux.push(fl)
    linFlux.push(fa)
    prevLog = log
    prevLin = lin
  }
  const fps = sr / hop
  return { env: highPass(logFlux, fps), accent: highPass(linFlux, fps), fps }
}

/** Autocorrelation at a fractional lag (linear interpolation). */
function acf(env: Float64Array, lag: number): number {
  const li = Math.floor(lag)
  const f = lag - li
  const n = env.length - li - 1
  if (n <= 0) return 0
  let s = 0
  for (let t = 0; t < n; t++) s += env[t] * (env[t + li] * (1 - f) + env[t + li + 1] * f)
  return s / n
}

/** Periodicity at a tempo, summed over several beat multiples (longer spans = finer precision). */
function combScore(env: Float64Array, fps: number, bpm: number, multiples: number): number {
  const lag = (60 * fps) / bpm
  let s = 0
  let used = 0
  for (let m = 1; m <= multiples && m * lag < env.length * 0.6; m++) {
    s += acf(env, m * lag)
    used++
  }
  return used ? s / used : 0
}

/** Share of the total held by the largest `frac` of the values. */
function topShare(v: Float64Array, frac: number): number {
  const sorted = Float64Array.from(v).sort().reverse()
  let total = 0
  let top = 0
  const k = Math.ceil(sorted.length * frac)
  for (let i = 0; i < sorted.length; i++) {
    total += sorted[i]
    if (i < k) top += sorted[i]
  }
  return total > 0 ? top / total : 0
}

/** Gentle preference for common tempos, used only to break near-ties. */
const tempoPrior = (bpm: number): number => Math.exp(-0.5 * (Math.log2(bpm / 120) / 1.2) ** 2)

export function fold(bpm: number): number {
  let b = bpm
  while (b < 70) b *= 2
  while (b >= 180) b /= 2
  return b
}

export function detectBpm(x: Float32Array, sr: number, durationSec: number): { bpm: number; confidence: number } | null {
  if (x.length < sr * 1.2 || rms(x) < 1e-4) return null
  const { env, accent, fps } = onsetEnvelope(x, sr)
  if (env.every((v) => v === 0)) return null

  // Coarse search.
  const scores: Array<{ bpm: number; score: number }> = []
  for (let bpm = 60; bpm <= 200; bpm += 0.5) scores.push({ bpm, score: combScore(env, fps, bpm, 4) * tempoPrior(bpm) })
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a))
  const sorted = scores.map((s) => s.score).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  if (best.score <= 0) return null
  // Sure when one tempo clearly stands out AND the onsets really repeat at it (a pad with one
  // attack has a "peak" too, but almost none of its onset energy repeats).
  const zeroLag = acf(env, 0)
  const periodicity = zeroLag > 0 ? combScore(env, fps, best.bpm, 4) / zeroLag : 0
  // Hits put most of their onset energy in a few frames; a pad's slow swells and beating
  // partials spread it out. (Drum loops measure ~0.8-0.9 here, a held pad ~0.55.)
  const spiky = Math.max(0, Math.min(1, (topShare(env, 0.1) - 0.55) / 0.2))
  let confidence = Math.max(0, Math.min(1, (best.score - median) / best.score)) * Math.min(1, periodicity / 0.25) * spiky

  // Fine search around the peak, using as many beat multiples as the signal allows.
  let bpm = best.bpm
  let fineBest = -Infinity
  for (let b = best.bpm - 0.75; b <= best.bpm + 0.75; b += 0.01) {
    const s = combScore(env, fps, b, 32)
    if (s > fineBest) {
      fineBest = s
      bpm = b
    }
  }
  bpm = fold(bpm)

  // Half or double time? Between 70 and 180 both 85 and 170 fit. Take the faster one only if
  // its pulse is about as strong as the slower one's: kick/snare on every beat (dnb at 174)
  // passes; hats alone between the beats (boom bap at 85) don't.
  const pair = bpm < 90 && bpm * 2 < 180 ? [bpm, bpm * 2] : bpm >= 140 ? [bpm / 2, bpm] : null
  if (pair) {
    const fastLag = (60 * fps) / pair[1]
    const fastPulse = acf(accent, fastLag)
    const slowPulse = acf(accent, fastLag * 2)
    bpm = fastPulse < 0.6 * slowPulse ? pair[0] : pair[1]
  }

  // Loops are usually cut to whole bars: if the length says "8 bars at 140", trust it.
  if (durationSec > 0 && durationSec <= 60) {
    let snap: number | null = null
    for (const bars of [1, 2, 4, 8, 16, 32, 64]) {
      const c = fold((240 * bars) / durationSec)
      if (Math.abs(c - bpm) / bpm < 0.02 && (snap == null || Math.abs(c - bpm) < Math.abs(snap - bpm))) snap = c
    }
    if (snap != null) {
      bpm = snap
      confidence = Math.min(1, confidence + 0.2)
    }
  }

  const rounded = Math.abs(bpm - Math.round(bpm)) < 0.15 ? Math.round(bpm) : Math.round(bpm * 10) / 10
  return { bpm: rounded, confidence: Math.round(confidence * 100) / 100 }
}

// ---------- key ----------

// Temperley (Kostka-Payne) key profiles: how typical each scale degree is in a major/minor key.
const MAJOR = [0.748, 0.06, 0.488, 0.082, 0.67, 0.46, 0.096, 0.715, 0.104, 0.366, 0.057, 0.4]
const MINOR = [0.712, 0.084, 0.474, 0.618, 0.049, 0.46, 0.105, 0.747, 0.404, 0.067, 0.133, 0.33]

/** Energy per pitch class (C..B) across the signal. */
export function chroma(x: Float32Array, sr: number, fmin: number, fmax: number): Float64Array {
  const size = nextPow2(sr * 0.74)
  const out = new Float64Array(12)
  for (const mag of spectra(x, size, size / 2)) {
    for (let k = 1; k < mag.length; k++) {
      const f = (k * sr) / size
      if (f < fmin || f > fmax) continue
      const p = 69 + 12 * Math.log2(f / 440)
      const r = Math.round(p)
      const d = Math.abs(p - r)
      // Bins between two semitones are ambiguous; count the ones near a note.
      if (d > 0.35) continue
      out[((r % 12) + 12) % 12] += mag[k] * mag[k] * (1 - d)
    }
  }
  return out
}

function pearson(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = a.length
  let ma = 0
  let mb = 0
  for (let i = 0; i < n; i++) {
    ma += a[i] / n
    mb += b[i] / n
  }
  let num = 0
  let da = 0
  let db = 0
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da && db ? num / Math.sqrt(da * db) : 0
}

export function detectKey(x: Float32Array, sr: number, oneShot: boolean): { key: string; confidence: number } | null {
  if (rms(x) < 1e-4) return null
  if (oneShot) {
    // A single sound: its strongest pitch class is the note (808s live down to ~30 Hz).
    const c = chroma(x, sr, 25, 1000)
    const total = c.reduce((a, b) => a + b, 0)
    if (!total) return null
    const pc = c.indexOf(Math.max(...c))
    return { key: NOTES[pc], confidence: Math.round((c[pc] / total) * 100) / 100 }
  }
  // Compress so one loud note doesn't decide the key on its own.
  const c = chroma(x, sr, 55, 2000).map((v) => Math.sqrt(v))
  const candidates: Array<{ key: string; r: number }> = []
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = (profile: number[]): number[] => profile.map((_, i) => profile[(i - tonic + 12) % 12])
    candidates.push({ key: NOTES[tonic], r: pearson(c, rot(MAJOR)) })
    candidates.push({ key: NOTES[tonic] + 'm', r: pearson(c, rot(MINOR)) })
  }
  candidates.sort((a, b) => b.r - a.r)
  const [first, second] = candidates
  if (first.r <= 0) return null
  // Sure when the best key fits well and clearly beats the runner-up.
  const confidence = Math.max(0, Math.min(1, first.r)) * Math.min(1, (first.r - second.r) * 8)
  return { key: first.key, confidence: Math.round(confidence * 100) / 100 }
}

// ---------- both ----------

export function analyzeSignal(x: Float32Array, sr: number, req: AnalysisRequest): AnalysisResult {
  const tempo = req.bpm ? detectBpm(x, sr, req.durationSec) : null
  const key = req.key ? detectKey(x, sr, req.oneShot) : null
  return {
    bpm: tempo?.bpm ?? null,
    bpmConfidence: tempo?.confidence ?? 0,
    key: key?.key ?? null,
    keyConfidence: key?.confidence ?? 0
  }
}
