import { describe, expect, it } from 'vitest'
import { normalizeKey, parseBpm, parseKey } from '../src/main/scan/parseName'

describe('parseBpm', () => {
  it.each([
    ['Dark_Loop_140bpm_Am', 140, 'explicit'],
    ['melody 92 BPM F#min', 92, 'explicit'],
    ['BPM_128 house chord', 128, 'explicit'],
    ['vox chop 87.5bpm', 87.5, 'explicit'],
    ['trap-melody-150-bpm', 150, 'explicit'],
    ['Loop_140_Am', 140, 'inferred'],
    ['Piano (95) Cmaj', 95, 'inferred']
  ])('%s -> %d', (name, bpm, confidence) => {
    expect(parseBpm(name)).toEqual({ bpm, confidence })
  })

  it.each(['Kick 01', '808 Mafia Sub', 'Snare_909', 'Beat 2024 final', 'hat_001', 'Sample 5', 'Vocal take 250', 'session-07'])(
    'finds no BPM in %s',
    (name) => {
      expect(parseBpm(name)).toBeNull()
    }
  )

  it('prefers an explicit bpm over a bare number', () => {
    expect(parseBpm('Pack 100 Loop 140bpm')).toEqual({ bpm: 140, confidence: 'explicit' })
  })
})

describe('parseKey', () => {
  it.each([
    ['Dark_Loop_140bpm_Am', 'Am'],
    ['melody 92 BPM F#min', 'F#m'],
    ['Guitar C# Minor 120', 'C#m'],
    ['Pad_Bbmaj_90bpm', 'A#'],
    ['Keys Eb minor', 'D#m'],
    ['pluck_Gmin_140', 'Gm'],
    ['Strings D major', 'D'],
    ['Lead_Fmaj7', 'F'],
    ['chords_a_minor', 'Am'],
    ['Loop_140_C', 'C'],
    ['Bell Key of F#', 'F#'],
    ['Abm_trap_loop', 'G#m']
  ])('%s -> %s', (name, key) => {
    expect(parseKey(name)).toBe(key)
  })

  it.each(['Kick_Hard', 'Ambient pad', 'am i dreaming demo', 'Emotional vox', 'FM bass', 'Drum loop 01', 'Snare_A', 'Dmx kit', 'Clap B 2'])(
    'finds no key in %s',
    (name) => {
      expect(parseKey(name)).toBeNull()
    }
  )
})

describe('normalizeKey', () => {
  it('uses sharps and wraps around the octave', () => {
    expect(normalizeKey('C', 'b', false)).toBe('B')
    expect(normalizeKey('B', '#', true)).toBe('Cm')
    expect(normalizeKey('g', 'flat', true)).toBe('F#m')
  })
})
