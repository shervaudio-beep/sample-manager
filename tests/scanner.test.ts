import { mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addRoot, countFiles, getWaveform, libraryCounts, openDb, removeRoot, saveWaveform, type Db } from '../src/main/db'
import { isAudioFile, scanRoot } from '../src/main/scan/scanner'
import { makeWav, tempDir, writeTree } from './helpers'

let dir: string
let lib: string
let db: Db

beforeEach(() => {
  dir = tempDir()
  lib = path.join(dir, 'library')
  mkdirSync(lib)
  db = openDb(path.join(dir, 'index.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const rowByName = (name: string) =>
  db.prepare('SELECT * FROM files WHERE name = ?').get(name) as Record<string, any> | undefined

describe('isAudioFile', () => {
  it('accepts every supported extension in any case and rejects the rest', () => {
    for (const f of ['a.wav', 'a.WAV', 'a.mp3', 'a.aif', 'a.aiff', 'a.flac', 'a.ogg', 'a.m4a']) expect(isAudioFile(f)).toBe(true)
    for (const f of ['a.als', 'a.flp', 'a.asd', 'a.mid', 'a.txt', '._kick.wav']) expect(isAudioFile(f)).toBe(false)
  })
})

describe('scanRoot', () => {
  it('indexes audio files with metadata, category, BPM and key', async () => {
    writeTree(lib, {
      'Drums/Kicks/Kick_Punchy.wav': makeWav(0.4, { bitDepth: 24, sampleRate: 48000, channels: 1 }),
      'Loops/Dark Melody 140bpm Am.wav': makeWav(6.9),
      'Beats/Nightfall.wav': makeWav(95, { sampleRate: 8000, channels: 1 }),
      'Project.als': 'not audio',
      '.hidden/secret.wav': makeWav(0.1),
      'node_modules/x.wav': makeWav(0.1)
    })
    const root = addRoot(db, lib)
    const s = await scanRoot(db, root.id)

    expect(s).toMatchObject({ added: 3, updated: 0, unchanged: 0, missing: 0, errors: 0, offline: false })
    const kick = rowByName('Kick_Punchy.wav')!
    expect(kick).toMatchObject({ category: 'drum', subtype: 'kick', sample_rate: 48000, bit_depth: 24, channels: 1, ext: 'wav' })
    expect(kick.duration_ms).toBe(400)

    const loop = rowByName('Dark Melody 140bpm Am.wav')!
    expect(loop).toMatchObject({ category: 'music', bpm: 140, bpm_source: 'filename', musical_key: 'Am', key_source: 'filename' })

    expect(rowByName('Nightfall.wav')).toMatchObject({ category: 'beat' })
    expect(libraryCounts(db).byCategory).toEqual({ beat: 1, demo: 0, music: 1, drum: 1 })
  })

  it('rescans: skips unchanged, picks up new/changed, marks deleted as missing', async () => {
    writeTree(lib, {
      'a/kick 1.wav': makeWav(0.3, { seed: 1 }),
      'a/snare 1.wav': makeWav(0.3, { seed: 2 }),
      'a/clap 1.wav': makeWav(0.3, { seed: 3 })
    })
    const root = addRoot(db, lib)
    await scanRoot(db, root.id)

    writeTree(lib, { 'b/hat 1.wav': makeWav(0.2) })
    rmSync(path.join(lib, 'a/clap 1.wav'))
    const snare = path.join(lib, 'a/snare 1.wav')
    writeFileSync(snare, makeWav(0.6, { seed: 2 }))
    const later = new Date(statSync(snare).mtimeMs + 5000)
    utimesSync(snare, later, later)

    const s = await scanRoot(db, root.id)
    expect(s).toMatchObject({ added: 1, updated: 1, unchanged: 1, missing: 1, relinked: 0 })
    expect(rowByName('snare 1.wav')!.duration_ms).toBe(600)
    expect(rowByName('clap 1.wav')!.status).toBe('missing')
    expect(countFiles(db, {})).toBe(3)

    // Putting the file back brings the same row back.
    writeTree(lib, { 'a/clap 1.wav': makeWav(0.3, { seed: 3 }) })
    await scanRoot(db, root.id)
    expect(rowByName('clap 1.wav')!.status).toBe('ok')
  })

  it('never overwrites manual edits on rescan', async () => {
    const file = path.join(lib, 'loop 120bpm.wav')
    writeTree(lib, { 'loop 120bpm.wav': makeWav(4) })
    const root = addRoot(db, lib)
    await scanRoot(db, root.id)
    db.prepare(
      `UPDATE files SET category = 'drum', category_source = 'manual', subtype = 'drum_loop', subtype_source = 'manual',
       bpm = 121, bpm_source = 'manual', musical_key = 'Gm', key_source = 'manual'`
    ).run()

    writeFileSync(file, makeWav(4.5))
    const later = new Date(Date.now() + 10_000)
    utimesSync(file, later, later)
    await scanRoot(db, root.id)

    expect(rowByName('loop 120bpm.wav')).toMatchObject({
      category: 'drum',
      subtype: 'drum_loop',
      bpm: 121,
      musical_key: 'Gm',
      duration_ms: 4500
    })
  })

  it('relinks a moved file and keeps its rating, notes and tags', async () => {
    writeTree(lib, { 'Downloads/808 Dist.wav': makeWav(1.5, { seed: 9 }) })
    const root = addRoot(db, lib)
    await scanRoot(db, root.id)
    const original = rowByName('808 Dist.wav')!
    db.prepare(`UPDATE files SET rating = 5, favorite = 1, notes = 'the one' WHERE id = ?`).run(original.id)
    db.prepare(`INSERT INTO tags (name) VALUES ('hard')`).run()
    db.prepare(`INSERT INTO file_tags (file_id, tag_id) VALUES (?, 1)`).run(original.id)

    mkdirSync(path.join(lib, 'Drums/808s'), { recursive: true })
    renameSync(path.join(lib, 'Downloads/808 Dist.wav'), path.join(lib, 'Drums/808s/808 Dist.wav'))
    const s = await scanRoot(db, root.id)

    expect(s).toMatchObject({ added: 0, missing: 0, relinked: 1 })
    const moved = rowByName('808 Dist.wav')!
    expect(moved.id).toBe(original.id)
    expect(moved.path).toBe(path.join(lib, 'Drums/808s/808 Dist.wav'))
    expect(moved).toMatchObject({ status: 'ok', rating: 5, favorite: 1, notes: 'the one' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM file_tags WHERE file_id = ?').get(original.id)).toEqual({ n: 1 })
    expect(countFiles(db, { includeMissing: true })).toBe(1)
  })

  it('marks an unplugged folder offline without losing anything', async () => {
    writeTree(lib, { 'kick.wav': makeWav(0.2) })
    const root = addRoot(db, lib)
    await scanRoot(db, root.id)

    const parked = lib + '-unplugged'
    renameSync(lib, parked)
    const s = await scanRoot(db, root.id)
    expect(s.offline).toBe(true)
    expect(rowByName('kick.wav')!.status).toBe('offline')
    expect(db.prepare('SELECT status FROM roots').get()).toEqual({ status: 'offline' })

    renameSync(parked, lib)
    await scanRoot(db, root.id)
    expect(rowByName('kick.wav')!.status).toBe('ok')
  })

  it('indexes unreadable audio with an error instead of failing the scan', async () => {
    writeTree(lib, { 'broken kick.wav': 'definitely not a wav', 'good snare.wav': makeWav(0.2) })
    const root = addRoot(db, lib)
    const s = await scanRoot(db, root.id)
    expect(s.added).toBe(2)
    expect(s.errors).toBe(1)
    const broken = rowByName('broken kick.wav')!
    expect(broken.scan_error).toBeTruthy()
    expect(broken.category).toBe('drum')
  })

  it('never modifies the files it scans', async () => {
    const content = makeWav(0.5, { seed: 4 })
    writeTree(lib, { 'clap.wav': content })
    const before = statSync(path.join(lib, 'clap.wav')).mtimeMs
    const root = addRoot(db, lib)
    await scanRoot(db, root.id)
    await scanRoot(db, root.id)
    expect(readFileSync(path.join(lib, 'clap.wav')).equals(content)).toBe(true)
    expect(statSync(path.join(lib, 'clap.wav')).mtimeMs).toBe(before)
  })

  it('handles a few thousand files in batches', async () => {
    const files: Record<string, Buffer> = {}
    const wav = makeWav(0.05, { channels: 1, sampleRate: 8000 })
    for (let i = 0; i < 2000; i++) files[`pack${i % 20}/hat ${i}.wav`] = wav
    writeTree(lib, files)
    const root = addRoot(db, lib)
    const progress: number[] = []
    const s = await scanRoot(db, root.id, { batchSize: 100, onProgress: (_f, p) => progress.push(p) })
    expect(s.added).toBe(2000)
    expect(progress.at(-1)).toBe(2000)
    const again = await scanRoot(db, root.id)
    expect(again).toMatchObject({ added: 0, unchanged: 2000 })
  }, 60_000)
})

describe('waveform cache', () => {
  it('returns cached peaks until the file changes on disk', async () => {
    const file = path.join(lib, 'pad.wav')
    writeTree(lib, { 'pad.wav': makeWav(2) })
    const root = addRoot(db, lib)
    await scanRoot(db, root.id)
    const id = rowByName('pad.wav')!.id as number

    expect(getWaveform(db, id)).toBeNull()
    saveWaveform(db, id, { duration: 2, peaks: [[0, 0.5, -0.5]] })
    expect(getWaveform(db, id)).toEqual({ duration: 2, peaks: [[0, 0.5, -0.5]] })

    writeFileSync(file, makeWav(3))
    const later = new Date(Date.now() + 10_000)
    utimesSync(file, later, later)
    await scanRoot(db, root.id)
    expect(getWaveform(db, id)).toBeNull()
  })

  it('is removed with its library folder', async () => {
    writeTree(lib, { 'pad.wav': makeWav(1) })
    const root = addRoot(db, lib)
    await scanRoot(db, root.id)
    saveWaveform(db, rowByName('pad.wav')!.id, { duration: 1, peaks: [[0]] })
    removeRoot(db, root.id)
    expect(db.prepare('SELECT COUNT(*) AS n FROM waveforms').get()).toEqual({ n: 0 })
  })
})
