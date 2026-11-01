import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addRoot,
  addTags,
  countFiles,
  getFile,
  libraryCounts,
  listTags,
  normalizeTagName,
  openDb,
  queryFiles,
  queryIds,
  removeRoot,
  removeTags,
  tagsForFiles,
  updateFiles,
  type Db
} from '../src/main/db'
import { scanRoot } from '../src/main/scan/scanner'
import type { FileRow } from '../src/shared/types'
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
    'Kick Hard.wav': makeWav(0.3, { seed: 1 }),
    'Snare Crack.wav': makeWav(0.3, { seed: 2 }),
    'Pad Loop 120bpm Am.wav': makeWav(4, { seed: 3 }),
    'Song Idea.wav': makeWav(100, { sampleRate: 8000, channels: 1, seed: 4 })
  })
  rootId = addRoot(db, lib).id
  await scanRoot(db, rootId)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const byName = (name: string): FileRow =>
  getFile(db, (db.prepare('SELECT id FROM files WHERE name = ?').get(name) as { id: number }).id)!

const rescanAfterChange = async (name: string, seconds: number): Promise<void> => {
  const file = path.join(lib, name)
  writeFileSync(file, makeWav(seconds, { seed: 9 }))
  const later = new Date(Date.now() + 10_000)
  utimesSync(file, later, later)
  await scanRoot(db, rootId)
}

describe('updateFiles', () => {
  it('stores manual category, type, BPM and key with a manual source', () => {
    const pad = byName('Pad Loop 120bpm Am.wav')
    updateFiles(db, [pad.id], { bpm: 121.5, key: 'Gm' })
    expect(byName('Pad Loop 120bpm Am.wav')).toMatchObject({ bpm: 121.5, bpmSource: 'manual', key: 'Gm', keySource: 'manual' })

    const kick = byName('Kick Hard.wav')
    updateFiles(db, [kick.id], { subtype: '808' })
    expect(byName('Kick Hard.wav')).toMatchObject({ category: 'drum', subtype: '808', subtypeSource: 'manual' })
  })

  it('keeps category and drum type consistent', () => {
    const snare = byName('Snare Crack.wav')
    updateFiles(db, [snare.id], { category: 'music' })
    expect(byName('Snare Crack.wav')).toMatchObject({ category: 'music', categorySource: 'manual', subtype: null })

    const pad = byName('Pad Loop 120bpm Am.wav')
    updateFiles(db, [pad.id], { subtype: 'drum_loop' })
    expect(byName('Pad Loop 120bpm Am.wav')).toMatchObject({ category: 'drum', subtype: 'drum_loop' })
  })

  it('edits many files at once', () => {
    const ids = queryIds(db, { sort: 'name', desc: false })
    expect(ids).toHaveLength(4)
    updateFiles(db, ids, { rating: 4, favorite: true })
    expect(queryFiles(db, { sort: 'name', desc: false, offset: 0, limit: 10 }).every((f) => f.rating === 4 && f.favorite)).toBe(true)
    expect(libraryCounts(db).favorites).toBe(4)
  })

  it('rejects values that make no sense', () => {
    const id = byName('Kick Hard.wav').id
    expect(() => updateFiles(db, [id], { rating: 6 })).toThrow()
    expect(() => updateFiles(db, [id], { rating: 2.5 })).toThrow()
    expect(() => updateFiles(db, [id], { bpm: 5 })).toThrow()
    expect(() => updateFiles(db, [id], { bpm: Number.NaN })).toThrow()
    expect(() => updateFiles(db, [id], { key: 'H#' })).toThrow()
    expect(() => updateFiles(db, [id], { category: 'podcast' as never })).toThrow()
    expect(() => updateFiles(db, [id], { subtype: 'cowbell' as never })).toThrow()
    expect(byName('Kick Hard.wav')).toMatchObject({ rating: 0, category: 'drum', subtype: 'kick' })
  })

  it('survives a rescan of a changed file, including a cleared BPM', async () => {
    const pad = byName('Pad Loop 120bpm Am.wav')
    updateFiles(db, [pad.id], { category: 'beat', bpm: null, key: 'C', rating: 5, notes: 'use for intro' })
    await rescanAfterChange('Pad Loop 120bpm Am.wav', 5)
    expect(byName('Pad Loop 120bpm Am.wav')).toMatchObject({
      category: 'beat',
      bpm: null,
      bpmSource: 'manual',
      key: 'C',
      rating: 5,
      notes: 'use for intro',
      durationMs: 5000
    })
  })

  it('leaves auto values to the next scan when they were not edited', async () => {
    const pad = byName('Pad Loop 120bpm Am.wav')
    updateFiles(db, [pad.id], { rating: 3 })
    await rescanAfterChange('Pad Loop 120bpm Am.wav', 5)
    expect(byName('Pad Loop 120bpm Am.wav')).toMatchObject({ bpm: 120, bpmSource: 'filename', rating: 3 })
  })
})

describe('tags', () => {
  it('normalizes names', () => {
    expect(normalizeTagName('  dark   vibes ')).toBe('dark vibes')
    expect(normalizeTagName('   ')).toBeNull()
    expect(normalizeTagName('x'.repeat(41))).toBeNull()
  })

  it('adds tags to several files, case-insensitively, without duplicates', () => {
    const kick = byName('Kick Hard.wav').id
    const snare = byName('Snare Crack.wav').id
    addTags(db, [kick, snare], ['Hard', 'trap'])
    addTags(db, [kick], ['hard', 'TRAP', 'punchy'])
    expect(byName('Kick Hard.wav').tags).toEqual(['Hard', 'punchy', 'trap'])
    expect(byName('Snare Crack.wav').tags).toEqual(['Hard', 'trap'])
    expect(listTags(db).map((t) => [t.name, t.count])).toEqual([
      ['Hard', 2],
      ['punchy', 1],
      ['trap', 2]
    ])
    expect(tagsForFiles(db, [snare]).map((t) => t.name)).toEqual(['Hard', 'trap'])
  })

  it('removes tags and forgets ones no file uses', () => {
    const kick = byName('Kick Hard.wav').id
    const snare = byName('Snare Crack.wav').id
    addTags(db, [kick, snare], ['hard', 'once'])
    removeTags(db, [kick, snare], ['ONCE'])
    removeTags(db, [kick], ['hard'])
    expect(listTags(db).map((t) => [t.name, t.count])).toEqual([['hard', 1]])
    expect(db.prepare('SELECT COUNT(*) AS n FROM tags').get()).toEqual({ n: 1 })
  })

  it('keeps tags through a rescan and drops them with the folder', async () => {
    const kick = byName('Kick Hard.wav').id
    addTags(db, [kick], ['hard'])
    await rescanAfterChange('Kick Hard.wav', 0.4)
    expect(byName('Kick Hard.wav').tags).toEqual(['hard'])
    removeRoot(db, rootId)
    expect(listTags(db)).toEqual([])
  })
})

describe('filters and ids', () => {
  it('filters by favorite and by tag', () => {
    const kick = byName('Kick Hard.wav').id
    const pad = byName('Pad Loop 120bpm Am.wav').id
    updateFiles(db, [kick], { favorite: true })
    addTags(db, [kick, pad], ['keep'])
    const tagId = listTags(db)[0].id
    expect(countFiles(db, { favorite: true })).toBe(1)
    expect(countFiles(db, { tagId })).toBe(2)
    expect(countFiles(db, { tagId, favorite: true })).toBe(1)
  })

  it('returns ids in the same order as the list, with ranges', () => {
    updateFiles(db, [byName('Snare Crack.wav').id], { rating: 5 })
    updateFiles(db, [byName('Song Idea.wav').id], { rating: 2 })
    const q = { sort: 'rating' as const, desc: true }
    const rows = queryFiles(db, { ...q, offset: 0, limit: 10 })
    expect(rows[0].name).toBe('Snare Crack.wav')
    expect(queryIds(db, q)).toEqual(rows.map((r) => r.id))
    expect(queryIds(db, { ...q, offset: 1, limit: 2 })).toEqual(rows.slice(1, 3).map((r) => r.id))
  })

  it('handles a selection bigger than SQLite’s parameter limit', () => {
    const ids = Array.from({ length: 40_000 }, (_, i) => i + 1)
    expect(() => updateFiles(db, ids, { rating: 1 })).not.toThrow()
    expect(() => addTags(db, ids, ['bulk'])).not.toThrow()
    expect(listTags(db)[0].count).toBe(4)
  })
})
