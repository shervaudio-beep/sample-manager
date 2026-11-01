import { describe, expect, it } from 'vitest'
import {
  analyzeSignal,
  APPLY_BPM_CONFIDENCE,
  APPLY_KEY_CONFIDENCE,
  detectBpm,
  detectKey,
  fft,
  fold
} from '../src/shared/analysis'

const SR = 11025

/** Small seeded PRNG so the "noise" in these tests is the same every run. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32 - 0.5
  }
}

function addTone(out: Float32Array, start: number, seconds: number, freq: number, amp: number, decay: number, harmonics = 1): void {
  const n = Math.min(out.length - start, Math.round(seconds * SR))
  for (let i = 0; i < n; i++) {
    const t = i / SR
    let v = 0
    for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * freq * h * t) / h
    out[start + i] += amp * v * Math.exp(-t * decay)
  }
}

function addNoise(out: Float32Array, start: number, seconds: number, amp: number, decay: number, rand: () => number): void {
  const n = Math.min(out.length - start, Math.round(seconds * SR))
  for (let i = 0; i < n; i++) out[start + i] += amp * rand() * Math.exp((-i / SR) * decay)
}

/** Kick on 1 and 3, snare on 2 and 4, hats on eighths. */
function drumLoop(bpm: number, bars: number, seed = 1): Float32Array {
  const beat = 60 / bpm
  const out = new Float32Array(Math.round(bars * 4 * beat * SR))
  const rand = rng(seed)
  for (let b = 0; b < bars * 4; b++) {
    const at = Math.round(b * beat * SR)
    if (b % 2 === 0) addTone(out, at, 0.3, 55, 0.9, 12)
    else addNoise(out, at, 0.2, 0.6, 18, rand)
    addNoise(out, at, 0.04, 0.25, 80, rand)
    addNoise(out, at + Math.round((beat / 2) * SR), 0.04, 0.18, 80, rand)
  }
  return out
}

const midi = (n: number): number => 440 * 2 ** ((n - 69) / 12)

/** Chords (MIDI note lists) one bar each, with the root doubled in the bass. */
function progression(chords: number[][], secondsPerChord = 2): Float32Array {
  const out = new Float32Array(Math.round(chords.length * secondsPerChord * SR))
  chords.forEach((notes, i) => {
    const at = Math.round(i * secondsPerChord * SR)
    addTone(out, at, secondsPerChord, midi(notes[0] - 12), 0.35, 0.6, 3)
    for (const n of notes) addTone(out, at, secondsPerChord, midi(n), 0.2, 0.8, 4)
  })
  return out
}

describe('fft', () => {
  it('finds a pure tone in the right bin', () => {
    const n = 1024
    const re = Float64Array.from({ length: n }, (_, i) => Math.sin((2 * Math.PI * 64 * i) / n))
    const im = new Float64Array(n)
    fft(re, im)
    const mags = Array.from({ length: n / 2 }, (_, k) => Math.hypot(re[k], im[k]))
    expect(mags.indexOf(Math.max(...mags))).toBe(64)
    expect(mags[64]).toBeCloseTo(n / 2, 3)
  })
})

describe('detectBpm', () => {
  it.each([
    [140, 4],
    [128, 8],
    [85, 2],
    [174, 4],
    [100, 4],
    [122, 8]
  ])('gets %i BPM exactly from a %i-bar loop', (bpm, bars) => {
    const x = drumLoop(bpm, bars, bpm)
    const r = detectBpm(x, SR, x.length / SR)!
    expect(r.bpm).toBe(bpm)
    expect(r.confidence).toBeGreaterThanOrEqual(APPLY_BPM_CONFIDENCE)
  })

  it('is close on a recording that is not cut to whole bars', () => {
    const x = drumLoop(93, 8, 3).subarray(0, Math.round(11.3 * SR))
    const r = detectBpm(x, SR, 11.3)!
    expect(Math.abs(r.bpm - 93)).toBeLessThanOrEqual(0.5)
    expect(r.confidence).toBeGreaterThanOrEqual(APPLY_BPM_CONFIDENCE)
  })

  it('handles a long beat (no bar snapping), within half a BPM', () => {
    const x = drumLoop(137.5, 48, 9) // ~84 s
    const r = detectBpm(x, SR, x.length / SR)!
    expect(Math.abs(r.bpm - 137.5)).toBeLessThanOrEqual(0.5)
  })

  it('folds into 70-180, so trap is 140 rather than 70 and slow loops double', () => {
    expect(fold(70)).toBe(70)
    expect(fold(65)).toBe(130)
    expect(fold(280)).toBe(140)
    expect(fold(180)).toBe(90)
  })

  it('gives up on silence and is unsure about a pad with no beat', () => {
    expect(detectBpm(new Float32Array(SR * 4), SR, 4)).toBeNull()
    const pad = progression([[57, 60, 64]], 6)
    const r = detectBpm(pad, SR, 6)
    expect(r == null || r.confidence < APPLY_BPM_CONFIDENCE).toBe(true)
  })
})

describe('detectKey', () => {
  it('finds a minor key from a i-iv-v-i progression', () => {
    // Am, Dm, Em, Am
    const x = progression([
      [57, 60, 64],
      [62, 65, 69],
      [64, 67, 71],
      [57, 60, 64]
    ])
    const r = detectKey(x, SR, false)!
    expect(r.key).toBe('Am')
    expect(r.confidence).toBeGreaterThanOrEqual(APPLY_KEY_CONFIDENCE)
  })

  it('finds a major key from I-IV-V-I', () => {
    // C, F, G, C
    const x = progression([
      [60, 64, 67],
      [65, 69, 72],
      [67, 71, 74],
      [60, 64, 67]
    ])
    expect(detectKey(x, SR, false)!.key).toBe('C')
  })

  it('works in sharp keys too', () => {
    // F#m, Bm, C#m, F#m
    const x = progression([
      [54, 57, 61],
      [59, 62, 66],
      [61, 64, 68],
      [54, 57, 61]
    ])
    expect(detectKey(x, SR, false)!.key).toBe('F#m')
  })

  it('names the note of an 808', () => {
    const x = new Float32Array(Math.round(1.5 * SR))
    addTone(x, 0, 1.5, midi(29), 0.9, 2) // F1, ~43.7 Hz
    for (let i = 0; i < x.length; i++) x[i] = Math.tanh(x[i] * 2) // a bit of drive, like most 808s
    expect(detectKey(x, SR, true)!.key).toBe('F')
  })

  it('names the note of a melodic one-shot', () => {
    const x = new Float32Array(SR)
    addTone(x, 0, 1, midi(64), 0.5, 3, 6) // E4 with harmonics
    expect(detectKey(x, SR, true)!.key).toBe('E')
  })
})

describe('analyzeSignal', () => {
  it('only works out what is asked for', () => {
    const x = drumLoop(140, 4)
    expect(analyzeSignal(x, SR, { bpm: true, key: false, oneShot: false, durationSec: x.length / SR })).toMatchObject({ bpm: 140, key: null })
    expect(analyzeSignal(x, SR, { bpm: false, key: false, oneShot: false, durationSec: 1 })).toEqual({
      bpm: null,
      bpmConfidence: 0,
      key: null,
      keyConfidence: 0
    })
  })
})
