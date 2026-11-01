import { describe, expect, it } from 'vitest'
import { categorize, tokenize } from '../src/main/scan/categorize'

const cat = (relativePath: string, durationSec: number | null, hasBpm = false) =>
  categorize({ relativePath, durationSec, hasBpm })

describe('tokenize', () => {
  it('splits camelCase, digits and separators', () => {
    expect(tokenize('Kick01_HardHH-808Sub')).toEqual(['kick', '01', 'hard', 'hh', '808', 'sub'])
  })
})

describe('drum samples and sub-types', () => {
  it.each([
    ['Kits/Trap Kit/Kick_Punchy.wav', 0.4, 'kick'],
    ['Downloads/snr_tight_02.wav', 0.3, 'snare'],
    ['Pack/Claps/clap_layered.wav', 0.5, 'clap'],
    ['Pack/Hats/HH_closed_03.wav', 0.1, 'hihat_closed'],
    ['Pack/OH_long.wav', 0.9, 'hihat_open'],
    ['Pack/open hat 2.wav', 0.9, 'hihat_open'],
    ['808s/808_Dist_C.wav', 1.8, '808'],
    ['Drums/Percs/shaker_02.wav', 0.6, 'perc'],
    ['Drums/crash_wide.wav', 2.2, 'cymbal'],
    ['Drums/Loops/hat loop 140bpm.wav', 6.9, 'drum_loop'],
    ['Drums/snare_roll_fill.wav', 1.7, 'fill'],
    ['Breaks/amen break 136.wav', 7.0, 'drum_loop']
  ])('%s -> drum/%s', (p, d, sub) => {
    const r = cat(p, d, /\d{3}/.test(p))
    expect(r.category).toBe('drum')
    expect(r.subtype).toBe(sub)
  })

  it('treats an unnamed short hit inside a Drums folder as a drum', () => {
    expect(cat('Drums/Sample 01.wav', 0.5).category).toBe('drum')
  })

  it('marks a long bpm-tagged file in a drum folder as a drum loop', () => {
    expect(cat('Drum Kits/Groove 92bpm.wav', 10.4, true)).toMatchObject({ category: 'drum', subtype: 'drum_loop' })
  })

  it('an 808 slide in a Loops folder is an 808, not a melody', () => {
    expect(cat('Loops/808 slide G.wav', 2.5)).toMatchObject({ category: 'drum', subtype: '808' })
  })
})

describe('music samples', () => {
  it.each([
    'Loops/Dark Melody 140bpm Am.wav',
    'Vocals/vox chop 3.wav',
    'Downloads/piano_loop_90_Cmaj.wav',
    'Splice/sounds/bass_pluck_G.wav'
  ])('%s -> music', (p) => {
    const r = cat(p, 8)
    expect(r.category).toBe('music')
    expect(r.subtype).toBeNull()
  })
})

describe('beats and demos', () => {
  it.each([
    ['Beats/Dark Trap Beat 140.wav', 182],
    ['Exports/Nightfall (prod. sherv).mp3', 165],
    ['Desktop/Lonely type beat.mp3', 150],
    ['Desktop/untitled 4.wav', 200]
  ])('%s -> beat', (p, d) => {
    expect(cat(p, d).category).toBe('beat')
  })

  it.each([
    ['Voice Memos/New Recording 12.m4a', 45],
    ['Demos/hook idea.wav', 95],
    ['Desktop/beat idea 3.wav', 140],
    ['Ableton/My Song Project/Samples/Recorded/0001 Audio.wav', 30],
    ['bounces/rough mix v2.wav', 210]
  ])('%s -> demo', (p, d) => {
    expect(cat(p, d).category).toBe('demo')
  })

  it('never calls a 3-minute file a drum sample just because of its name', () => {
    expect(cat('Kicks/kick heavy beat.wav', 180).category).not.toBe('drum')
  })
})

describe('fallbacks', () => {
  it('uses duration alone when there is no other signal', () => {
    expect(cat('stuff/a.wav', 0.3).category).toBe('drum')
    expect(cat('stuff/a.wav', 12).category).toBe('music')
    expect(cat('stuff/a.wav', 160).category).toBe('beat')
    expect(cat('stuff/a.wav', null).category).toBe('music')
  })

  it('reports low confidence when guessing', () => {
    expect(cat('stuff/a.wav', 12).confidence).toBeLessThan(0.5)
  })
})
