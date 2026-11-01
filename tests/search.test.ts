import { mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addRoot, addTags, countFiles, openDb, parseSearch, queryFiles, removeRoot, removeTags, updateFiles, type Db } from '../src/main/db'
import { scanRoot } from '../src/main/scan/scanner'
import { camelot, compatibleKeys } from '../src/shared/keys'
import type { FileQuery } from '../src/shared/types'
import { makeWav, tempDir, writeTree } from './helpers'

let dir: string
let lib: string
let db: Db
let rootId: number

beforeEach(async () => {
  dir = tempDir()
  lib = path.join(dir, 'library')
  mkdirSync(lib)
  db = openDb(path.join(dir, 'index.db'))
  writeTree(lib, {
    'Drum Kits/Trap Kit/KickPunchy.wav': makeWav(0.3, { seed: 1 }),
    'Drum Kits/Trap Kit/Snare Crack.wav': makeWav(0.3, { seed: 2 }),
    'Drum Kits/Lofi/hat loop 70bpm.wav': makeWav(3.5, { seed: 3 }),
    'Loops/Dark Pad 140bpm Am.wav': makeWav(6.9, { seed: 4 }),
    'Loops/Bright Keys 128bpm C.wav': makeWav(7.5, { seed: 5 }),
    'Loops/Vox Chop 90bpm F#m.wav': makeWav(5.3, { seed: 6 }),
    'Beats/Nightfall 100% (final).wav': makeWav(95, { sampleRate: 8000, channels: 1, seed: 7 })
  })
  rootId = addRoot(db, lib).id
  await scanRoot(db, rootId)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const names = (q: Partial<FileQuery>): string[] =>
  queryFiles(db, { sort: 'name', desc: false, offset: 0, limit: 1000, ...q }).map((f) => f.name.replace(/\.wav$/, ''))
const id = (name: string): number => (db.prepare('SELECT id FROM files WHERE name = ?').get(name + '.wav') as { id: number }).id

describe('parseSearch', () => {
  it('splits words, keeps quoted phrases and spots exclusions', () => {
    expect(parseSearch('  dark   pad ')).toEqual([
      { term: 'dark', exclude: false },
      { term: 'pad', exclude: false }
    ])
    expect(parseSearch('"dark pad" -vox')).toEqual([
      { term: 'dark pad', exclude: false },
      { term: 'vox', exclude: true }
    ])
    expect(parseSearch('- "" "unclosed')).toEqual([{ term: 'unclosed', exclude: false }])
  })
})

describe('search', () => {
  it('finds any part of a name, ignoring case', () => {
    expect(names({ search: 'punch' })).toEqual(['KickPunchy'])
    // "loop" also matches everything in the Loops folder.
    expect(names({ search: 'LOOP' })).toEqual(['Bright Keys 128bpm C', 'Dark Pad 140bpm Am', 'hat loop 70bpm', 'Vox Chop 90bpm F#m'])
    expect(names({ search: 'hat loop' })).toEqual(['hat loop 70bpm'])
  })

  it('matches folder names', () => {
    expect(names({ search: 'trap kit' })).toEqual(['KickPunchy', 'Snare Crack'])
    expect(names({ search: 'lofi' })).toEqual(['hat loop 70bpm'])
  })

  it('needs every word to match, and - excludes', () => {
    expect(names({ search: 'loops pad' })).toEqual(['Dark Pad 140bpm Am'])
    expect(names({ search: 'loops -vox -keys' })).toEqual(['Dark Pad 140bpm Am'])
    expect(names({ search: '"dark pad"' })).toEqual(['Dark Pad 140bpm Am'])
    expect(names({ search: '"pad dark"' })).toEqual([])
  })

  it('handles short words and characters that mean something to SQL', () => {
    expect(names({ search: 'Am' })).toEqual(['Dark Pad 140bpm Am'])
    expect(names({ search: 'F#' })).toEqual(['Vox Chop 90bpm F#m'])
    expect(names({ search: '100%' })).toEqual(['Nightfall 100% (final)'])
    expect(names({ search: '"(final)"' })).toEqual(['Nightfall 100% (final)'])
    expect(names({ search: '%' })).toEqual(['Nightfall 100% (final)'])
    expect(names({ search: '_' })).toEqual([])
    expect(() => names({ search: 'a" OR 1=1 --' })).not.toThrow()
  })

  it('searches tags and notes, and follows edits', () => {
    addTags(db, [id('Snare Crack')], ['crispy'])
    updateFiles(db, [id('KickPunchy')], { notes: 'layer with a sub' })
    expect(names({ search: 'crisp' })).toEqual(['Snare Crack'])
    expect(names({ search: 'sub' })).toEqual(['KickPunchy'])
    removeTags(db, [id('Snare Crack')], ['crispy'])
    updateFiles(db, [id('KickPunchy')], { notes: '' })
    expect(names({ search: 'crisp' })).toEqual([])
    expect(names({ search: 'layer' })).toEqual([])
  })

  it('follows moved files and forgets removed folders', async () => {
    const kick = id('KickPunchy')
    mkdirSync(path.join(lib, 'Favourites'))
    renameSync(path.join(lib, 'Drum Kits/Trap Kit/KickPunchy.wav'), path.join(lib, 'Favourites/KickPunchy.wav'))
    await scanRoot(db, rootId)
    expect(id('KickPunchy')).toBe(kick)
    expect(names({ search: 'favourites' })).toEqual(['KickPunchy'])
    expect(names({ search: 'trap kit' })).toEqual(['Snare Crack'])

    removeRoot(db, rootId)
    expect(db.prepare('SELECT COUNT(*) AS n FROM files_fts').get()).toEqual({ n: 0 })
  })

  it('combines with the sidebar view', () => {
    expect(names({ search: 'loop', category: 'drum' })).toEqual(['hat loop 70bpm'])
    expect(countFiles(db, { search: 'kits' })).toBe(3)
  })
})

describe('filters', () => {
  it('filters by BPM range, optionally counting half and double time', () => {
    expect(names({ bpmMin: 120, bpmMax: 145 })).toEqual(['Bright Keys 128bpm C', 'Dark Pad 140bpm Am'])
    expect(names({ bpmMin: 138, bpmMax: 142, bpmHalfDouble: true })).toEqual(['Dark Pad 140bpm Am', 'hat loop 70bpm'])
    expect(names({ bpmMin: 175, bpmMax: 185, bpmHalfDouble: true })).toEqual(['Vox Chop 90bpm F#m'])
    expect(names({ bpmMax: 80 })).toEqual(['hat loop 70bpm'])
  })

  it('filters by keys', () => {
    expect(names({ keys: ['Am', 'C'] })).toEqual(['Bright Keys 128bpm C', 'Dark Pad 140bpm Am'])
    expect(names({ keys: ['not-a-key'] })).toHaveLength(7)
  })

  it('filters by rating, length and format', () => {
    updateFiles(db, [id('KickPunchy')], { rating: 5 })
    updateFiles(db, [id('Snare Crack')], { rating: 3 })
    expect(names({ minRating: 4 })).toEqual(['KickPunchy'])
    expect(names({ minRating: 3 })).toEqual(['KickPunchy', 'Snare Crack'])
    expect(names({ durationMax: 2000 })).toEqual(['KickPunchy', 'Snare Crack'])
    expect(names({ durationMin: 2000, durationMax: 30_000 })).toHaveLength(4)
    expect(names({ durationMin: 30_000 })).toEqual(['Nightfall 100% (final)'])
    expect(names({ exts: ['mp3'] })).toEqual([])
    expect(names({ exts: ['wav'] })).toHaveLength(7)
  })
})

describe('keys', () => {
  it('suggests harmonically compatible keys', () => {
    expect(compatibleKeys('Am')).toEqual(['Am', 'C', 'Em', 'Dm'])
    expect(compatibleKeys('C')).toEqual(['C', 'Am', 'G', 'F'])
    expect(compatibleKeys('F#m')).toEqual(['F#m', 'A', 'C#m', 'Bm'])
    expect(compatibleKeys('nope')).toEqual([])
  })

  it('gives Camelot codes', () => {
    expect(camelot('C')).toBe('8B')
    expect(camelot('Am')).toBe('8A')
    expect(camelot('G')).toBe('9B')
    expect(camelot('F')).toBe('7B')
    expect(camelot('B')).toBe('1B')
    expect(camelot('Ebm' as never)).toBeNull()
  })
})

describe('speed', () => {
  it('searches and filters 50,000 files quickly', () => {
    const words = ['kick', 'snare', 'hat', 'pad', 'keys', 'vox', 'bass', 'pluck', 'lead', 'perc']
    const insert = db.prepare(
      `INSERT INTO files (root_id, path, rel_path, name, ext, size, mtime_ms, category, bpm, musical_key, duration_ms, date_added, last_seen_scan)
       VALUES (?, ?, ?, ?, 'wav', 1000, 0, 'music', ?, ?, ?, 0, 0)`
    )
    db.exec('BEGIN')
    for (let i = 0; i < 50_000; i++) {
      const name = `${words[i % 10]} ${words[(i * 7) % 10]}Thing ${i}.wav`
      const rel = `Pack ${i % 200}/${name}`
      insert.run(rootId, path.join(lib, rel), rel, name, 60 + (i % 120), i % 3 ? 'Am' : 'C', 500 + (i % 20_000))
    }
    db.exec('COMMIT')

    const time = (q: Partial<FileQuery>): number => {
      const t = performance.now()
      countFiles(db, q)
      queryFiles(db, { sort: 'name', desc: false, offset: 0, limit: 200, ...q })
      return performance.now() - t
    }
    expect(countFiles(db, { search: 'pluck percthing' })).toBe(5000)
    const slowest = Math.max(
      time({ search: 'pluck' }),
      time({ search: 'pack 12 keysthing' }),
      time({ search: 'am' }),
      time({ search: 'kick', bpmMin: 138, bpmMax: 142, bpmHalfDouble: true, keys: ['Am', 'C'] }),
      time({ durationMax: 2000, sort: 'bpm' } as Partial<FileQuery>)
    )
    // A list update has to feel instant while typing.
    console.log('slowest 50k query (ms):', slowest.toFixed(1))
    expect(slowest).toBeLessThan(150)
  }, 60_000)
})
