import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addRoot,
  addToCollection,
  collectionsForFiles,
  countFiles,
  createCollection,
  deleteCollection,
  idsForPaths,
  listCollections,
  normalizeCollectionName,
  openDb,
  queryFiles,
  queryIds,
  removeFromCollection,
  removeRoot,
  renameCollection,
  type Db
} from '../src/main/db'
import { scanRoot } from '../src/main/scan/scanner'
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
    'Kicks/Kick A.wav': makeWav(0.3, { seed: 1 }),
    'Kicks/Kick B.wav': makeWav(0.3, { seed: 2 }),
    'Snares/Snare A.wav': makeWav(0.3, { seed: 3 }),
    'Loops/Pad 140bpm Am.wav': makeWav(4, { seed: 4 })
  })
  rootId = addRoot(db, lib).id
  await scanRoot(db, rootId)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const id = (name: string): number => (db.prepare('SELECT id FROM files WHERE name = ?').get(name + '.wav') as { id: number }).id
const inCollection = (collectionId: number, q: Partial<FileQuery> = {}): string[] =>
  queryFiles(db, { collectionId, includeMissing: true, sort: 'position', desc: false, offset: 0, limit: 100, ...q }).map((f) =>
    f.name.replace(/\.wav$/, '')
  )

describe('collections', () => {
  it('creates, renames and lists collections with counts', () => {
    const a = createCollection(db, '  EP   Drums ', [id('Kick A'), id('Snare A')])
    createCollection(db, '')
    expect(a).toMatchObject({ name: 'EP Drums', count: 2 })
    renameCollection(db, a.id, 'Album drums')
    expect(listCollections(db).map((c) => [c.name, c.count])).toEqual([
      ['Album drums', 2],
      ['New Collection', 0]
    ])
    expect(normalizeCollectionName('x'.repeat(100))).toHaveLength(80)
  })

  it('keeps files in the order they were added and ignores repeats and unknown ids', () => {
    const c = createCollection(db, 'Set', [id('Snare A'), id('Kick B')])
    addToCollection(db, c.id, [id('Kick B'), id('Pad 140bpm Am'), 99_999, id('Kick A')])
    expect(inCollection(c.id)).toEqual(['Snare A', 'Kick B', 'Pad 140bpm Am', 'Kick A'])
    expect(inCollection(c.id, { desc: true })).toEqual(['Kick A', 'Pad 140bpm Am', 'Kick B', 'Snare A'])
    expect(inCollection(c.id, { sort: 'name' })).toEqual(['Kick A', 'Kick B', 'Pad 140bpm Am', 'Snare A'])
    expect(queryIds(db, { collectionId: c.id, sort: 'position', desc: false })).toEqual(
      ['Snare A', 'Kick B', 'Pad 140bpm Am', 'Kick A'].map(id)
    )
  })

  it('lets a file be in several collections, and combines with other filters', () => {
    const a = createCollection(db, 'A', [id('Kick A'), id('Pad 140bpm Am')])
    const b = createCollection(db, 'B', [id('Kick A')])
    expect(collectionsForFiles(db, [id('Kick A'), id('Pad 140bpm Am')]).map((c) => [c.name, c.count])).toEqual([
      ['A', 2],
      ['B', 1]
    ])
    expect(countFiles(db, { collectionId: a.id, search: 'kick' })).toBe(1)
    expect(countFiles(db, { collectionId: b.id, category: 'music' })).toBe(0)
  })

  it('removes files from a collection without touching the library or disk', () => {
    const c = createCollection(db, 'Set', [id('Kick A'), id('Kick B')])
    removeFromCollection(db, c.id, [id('Kick A')])
    expect(inCollection(c.id)).toEqual(['Kick B'])
    expect(countFiles(db, {})).toBe(4)
    expect(existsSync(path.join(lib, 'Kicks/Kick A.wav'))).toBe(true)
  })

  it('deleting a collection only deletes the list', () => {
    const c = createCollection(db, 'Set', [id('Kick A')])
    deleteCollection(db, c.id)
    expect(listCollections(db)).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM collection_items').get()).toEqual({ n: 0 })
    expect(countFiles(db, {})).toBe(4)
    expect(existsSync(path.join(lib, 'Kicks/Kick A.wav'))).toBe(true)
  })

  it('keeps a moved file in its collections and shows missing ones', async () => {
    const c = createCollection(db, 'Set', [id('Kick A'), id('Snare A')])
    mkdirSync(path.join(lib, 'Picked'))
    renameSync(path.join(lib, 'Kicks/Kick A.wav'), path.join(lib, 'Picked/Kick A.wav'))
    rmSync(path.join(lib, 'Snares/Snare A.wav'))
    await scanRoot(db, rootId)

    const rows = queryFiles(db, { collectionId: c.id, includeMissing: true, sort: 'position', desc: false, offset: 0, limit: 10 })
    expect(rows.map((r) => [r.name, r.status])).toEqual([
      ['Kick A.wav', 'ok'],
      ['Snare A.wav', 'missing']
    ])
    expect(rows[0].path).toBe(path.join(lib, 'Picked/Kick A.wav'))
  })

  it('loses entries for a removed folder but keeps the collection', () => {
    const c = createCollection(db, 'Set', [id('Kick A')])
    removeRoot(db, rootId)
    expect(listCollections(db)).toEqual([expect.objectContaining({ id: c.id, count: 0 })])
  })

  it('ignores adds to a collection that no longer exists', () => {
    const c = createCollection(db, 'Gone')
    deleteCollection(db, c.id)
    expect(() => addToCollection(db, c.id, [id('Kick A')])).not.toThrow()
    expect(db.prepare('SELECT COUNT(*) AS n FROM collection_items').get()).toEqual({ n: 0 })
  })

  it('maps dropped file paths to library ids', () => {
    const p = path.join(lib, 'Kicks/Kick B.wav')
    expect(idsForPaths(db, [p, path.join(dir, 'elsewhere.wav')])).toEqual([id('Kick B')])
  })
})
