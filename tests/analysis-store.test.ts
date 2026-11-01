import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { addRoot, analysisQueue, getFile, markAnalyzed, openDb, resetAnalysis, saveAnalysis, updateFiles, type Db } from '../src/main/db'
import { scanRoot } from '../src/main/scan/scanner'
import { ANALYSIS_VERSION, planAnalysis } from '../src/shared/analysis'
import { makeWav, tempDir, writeTree } from './helpers'

let dir: string
let lib: string
let db: Db
let rootId: number
const T = { bpm: 0.35, key: 0.3 }
const V = ANALYSIS_VERSION

beforeEach(async () => {
  dir = tempDir()
  lib = path.join(dir, 'lib')
  mkdirSync(lib)
  db = openDb(path.join(dir, 'index.db'))
  writeTree(lib, {
    'Loops/Untitled Loop.wav': makeWav(4, { seed: 1 }),
    'Loops/Dark Loop 140bpm Am.wav': makeWav(4, { seed: 2 }),
    'Drums/Kicks/Kick.wav': makeWav(0.3, { seed: 3 }),
    'Drums/808s/808 Long.wav': makeWav(1.8, { seed: 4 })
  })
  rootId = addRoot(db, lib).id
  await scanRoot(db, rootId)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const id = (name: string): number => (db.prepare('SELECT id FROM files WHERE name = ?').get(name + '.wav') as { id: number }).id
const found = (bpm: number | null, key: string | null, conf = 0.9) => ({ bpm, bpmConfidence: conf, key, keyConfidence: conf })

describe('planAnalysis', () => {
  it('skips drum hits, gives an 808 its note, and loops their tempo and key', () => {
    expect(planAnalysis({ category: 'drum', subtype: 'kick', durationMs: 300 })).toBeNull()
    expect(planAnalysis({ category: 'drum', subtype: '808', durationMs: 1800 })).toMatchObject({ bpm: false, key: true, oneShot: true })
    expect(planAnalysis({ category: 'drum', subtype: 'drum_loop', durationMs: 7000 })).toMatchObject({ bpm: true, key: false })
    expect(planAnalysis({ category: 'music', subtype: null, durationMs: 7000 })).toMatchObject({ bpm: true, key: true, oneShot: false })
    expect(planAnalysis({ category: 'beat', subtype: null, durationMs: 180_000 })).toMatchObject({ bpm: true, key: true })
    expect(planAnalysis({ category: 'music', subtype: null, durationMs: 1000 })).toMatchObject({ bpm: false, key: true, oneShot: true })
  })
})

describe('saveAnalysis', () => {
  it('fills in a missing BPM and key when confident', () => {
    saveAnalysis(db, id('Untitled Loop'), V, found(128, 'Gm'), T)
    expect(getFile(db, id('Untitled Loop'))).toMatchObject({
      bpm: 128,
      bpmSource: 'analysis',
      key: 'Gm',
      keySource: 'analysis',
      analysisBpm: 128,
      analysisKey: 'Gm'
    })
  })

  it('keeps an unsure result to itself', () => {
    saveAnalysis(db, id('Untitled Loop'), V, found(128, 'Gm', 0.1), T)
    expect(getFile(db, id('Untitled Loop'))).toMatchObject({ bpm: null, key: null, analysisBpm: 128, analysisBpmConfidence: 0.1 })
  })

  it('never overrides the file name, and never a manual value, even a cleared one', () => {
    saveAnalysis(db, id('Dark Loop 140bpm Am'), V, found(70, 'C'), T)
    expect(getFile(db, id('Dark Loop 140bpm Am'))).toMatchObject({ bpm: 140, bpmSource: 'filename', key: 'Am', analysisBpm: 70, analysisKey: 'C' })

    updateFiles(db, [id('Untitled Loop')], { bpm: null, key: 'D' })
    saveAnalysis(db, id('Untitled Loop'), V, found(128, 'Gm'), T)
    expect(getFile(db, id('Untitled Loop'))).toMatchObject({ bpm: null, bpmSource: 'manual', key: 'D', keySource: 'manual' })
  })

  it('replaces its own earlier result when run again', () => {
    saveAnalysis(db, id('Untitled Loop'), V, found(128, 'Gm'), T)
    saveAnalysis(db, id('Untitled Loop'), V, found(126, 'G'), T)
    expect(getFile(db, id('Untitled Loop'))).toMatchObject({ bpm: 126, key: 'G' })
  })

  it('ignores a key it does not recognise', () => {
    saveAnalysis(db, id('Untitled Loop'), V, found(null, 'H#'), T)
    expect(getFile(db, id('Untitled Loop'))!.key).toBeNull()
  })
})

describe('analysis queue', () => {
  it('lists files once, newest first, and requeues on change or request', async () => {
    const all = analysisQueue(db, V).map((f) => f.id)
    expect(all).toHaveLength(4)
    markAnalyzed(db, all, V)
    expect(analysisQueue(db, V)).toEqual([])

    resetAnalysis(db, [id('Kick')])
    expect(analysisQueue(db, V).map((f) => f.id)).toEqual([id('Kick')])
    markAnalyzed(db, [id('Kick')], V)

    // A changed file loses its detected values (and the BPM they set) and is analyzed again.
    saveAnalysis(db, id('Untitled Loop'), V, found(128, 'Gm'), T)
    const file = path.join(lib, 'Loops/Untitled Loop.wav')
    writeFileSync(file, makeWav(5, { seed: 8 }))
    const later = new Date(Date.now() + 10_000)
    utimesSync(file, later, later)
    await scanRoot(db, rootId)
    expect(getFile(db, id('Untitled Loop'))).toMatchObject({ bpm: null, key: null, analysisBpm: null })
    expect(analysisQueue(db, V).map((f) => f.id)).toEqual([id('Untitled Loop')])

    // A newer algorithm version re-analyzes everything.
    expect(analysisQueue(db, V + 1)).toHaveLength(4)
  })
})
