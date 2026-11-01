import { readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addRoot,
  addTags,
  addToCollection,
  createCollection,
  duplicateStats,
  extraCopyIds,
  forgetFiles,
  getFile,
  mergeFileData,
  openDb,
  planTrash,
  queryFiles,
  updateFiles,
  type Db
} from '../src/main/db'
import { audioSpan } from '../src/main/dupes/audioSpan'
import { findDuplicates } from '../src/main/dupes/finder'
import { scanRoot } from '../src/main/scan/scanner'
import { makeWav, tempDir, writeTree } from './helpers'

let dir: string
let db: Db

beforeEach(() => {
  dir = tempDir()
  db = openDb(path.join(dir, 'index.db'))
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const audio = (n: number, seed = 1): Buffer => Buffer.from(Array.from({ length: n }, (_, i) => (i * 31 + seed * 7) & 0xff))

/** Read back the bytes audioSpan points at. */
async function spanBytes(name: string, content: Buffer): Promise<Buffer> {
  const file = path.join(dir, name)
  writeFileSync(file, content)
  const s = await audioSpan(file, path.extname(name).slice(1))
  return readFileSync(file).subarray(s.offset, s.offset + s.length)
}

function chunk(id: string, body: Buffer, le = true): Buffer {
  const h = Buffer.alloc(8)
  h.write(id, 0)
  if (le) h.writeUInt32LE(body.length, 4)
  else h.writeUInt32BE(body.length, 4)
  return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)])
}

function wavWith(data: Buffer, extra: Buffer[] = []): Buffer {
  const fmt = Buffer.alloc(16)
  fmt.writeUInt16LE(1, 0)
  fmt.writeUInt16LE(2, 2)
  fmt.writeUInt32LE(44100, 4)
  fmt.writeUInt32LE(176400, 8)
  fmt.writeUInt16LE(4, 12)
  fmt.writeUInt16LE(16, 14)
  const body = Buffer.concat([Buffer.from('WAVE'), chunk('fmt ', fmt), ...extra, chunk('data', data)])
  const h = Buffer.alloc(8)
  h.write('RIFF', 0)
  h.writeUInt32LE(body.length, 4)
  return Buffer.concat([h, body])
}

function id3v2(bodyLen: number): Buffer {
  const h = Buffer.alloc(10 + bodyLen)
  h.write('ID3', 0)
  h[3] = 4
  h[6] = (bodyLen >> 21) & 0x7f
  h[7] = (bodyLen >> 14) & 0x7f
  h[8] = (bodyLen >> 7) & 0x7f
  h[9] = bodyLen & 0x7f
  return h
}

describe('audioSpan', () => {
  it('finds the WAV data chunk past metadata chunks', async () => {
    const data = audio(1001)
    const plain = await spanBytes('a.wav', wavWith(data))
    const tagged = await spanBytes('b.wav', wavWith(data, [chunk('LIST', Buffer.from('INFOISFT tagged by a DAW')), chunk('bext', Buffer.alloc(602))]))
    expect(plain.equals(data)).toBe(true)
    expect(tagged.equals(data)).toBe(true)
  })

  it('finds AIFF sample data inside SSND', async () => {
    const data = audio(400)
    const comm = chunk('COMM', Buffer.alloc(18), false)
    const ssndBody = Buffer.concat([Buffer.alloc(8), data])
    const body = Buffer.concat([Buffer.from('AIFF'), comm, chunk('NAME', Buffer.from('Pad'), false), chunk('SSND', ssndBody, false)])
    const head = Buffer.alloc(8)
    head.write('FORM', 0)
    head.writeUInt32BE(body.length, 4)
    expect((await spanBytes('a.aiff', Buffer.concat([head, body]))).equals(data)).toBe(true)
  })

  it('strips ID3v2, ID3v1 and APE tags from MP3', async () => {
    const frames = audio(3000)
    const v1 = Buffer.concat([Buffer.from('TAG'), Buffer.alloc(125)])
    const apeFooter = Buffer.alloc(32)
    apeFooter.write('APETAGEX', 0)
    apeFooter.writeUInt32LE(2000, 8)
    apeFooter.writeUInt32LE(32 + 40, 12) // items + footer
    const ape = Buffer.concat([Buffer.alloc(40), apeFooter])
    const bare = await spanBytes('a.mp3', frames)
    const tagged = await spanBytes('b.mp3', Buffer.concat([id3v2(5000), id3v2(300), frames, ape, v1]))
    expect(bare.equals(frames)).toBe(true)
    expect(tagged.equals(frames)).toBe(true)
  })

  it('skips FLAC metadata blocks, including pictures', async () => {
    const frames = audio(2500)
    const block = (type: number, len: number, last: boolean): Buffer => {
      const b = Buffer.alloc(4 + len)
      b[0] = (last ? 0x80 : 0) | type
      b.writeUIntBE(len, 1, 3)
      return b
    }
    const plain = Buffer.concat([Buffer.from('fLaC'), block(0, 34, true), frames])
    const tagged = Buffer.concat([Buffer.from('fLaC'), block(0, 34, false), block(4, 120, false), block(6, 9000, true), frames])
    expect((await spanBytes('a.flac', plain)).equals(frames)).toBe(true)
    expect((await spanBytes('b.flac', tagged)).equals(frames)).toBe(true)
  })

  it('uses the mdat box of an M4A', async () => {
    const box = (type: string, body: Buffer): Buffer => {
      const h = Buffer.alloc(8)
      h.writeUInt32BE(8 + body.length, 0)
      h.write(type, 4)
      return Buffer.concat([h, body])
    }
    const data = audio(1500)
    const file = Buffer.concat([box('ftyp', Buffer.from('M4A isom')), box('moov', Buffer.alloc(700)), box('mdat', data)])
    expect((await spanBytes('a.m4a', file)).equals(data)).toBe(true)
  })

  it('falls back to the whole file for Ogg and for anything malformed', async () => {
    const ogg = Buffer.concat([Buffer.from('OggS'), audio(200)])
    expect((await spanBytes('a.ogg', ogg)).equals(ogg)).toBe(true)
    const junk = Buffer.from('not really a wav file')
    expect((await spanBytes('broken.wav', junk)).equals(junk)).toBe(true)
  })
})

describe('findDuplicates', () => {
  const lib = (): string => path.join(dir, 'lib')
  const big = (seed: number, mid = 0): Buffer => {
    const d = audio(300_000, seed)
    d[150_000] = mid
    return d
  }

  async function scan(files: Record<string, Buffer>): Promise<number> {
    writeTree(lib(), files)
    const root = addRoot(db, lib())
    await scanRoot(db, root.id)
    return root.id
  }
  const id = (rel: string): number => (db.prepare('SELECT id FROM files WHERE rel_path = ?').get(path.normalize(rel)) as { id: number }).id
  const groups = (): string[][] => {
    const rows = queryFiles(db, { duplicates: true, sort: 'name', desc: false, offset: 0, limit: 100 })
    const out = new Map<string, string[]>()
    for (const r of rows) out.set(r.audioHash!, [...(out.get(r.audioHash!) ?? []), r.name])
    return [...out.values()].map((g) => g.sort()).sort((a, b) => a[0].localeCompare(b[0]))
  }

  it('groups files with the same audio, whatever their names, folders or tags', async () => {
    const kick = makeWav(0.3, { seed: 5 })
    const kickData = kick.subarray(44)
    await scan({
      'Pack A/Kick 01.wav': kick,
      'Downloads/kick copy.wav': kick,
      'Tagged/Kick (bwf).wav': wavWith(kickData, [chunk('LIST', Buffer.from('INFOIART someone'))]),
      'Other/Snare.wav': makeWav(0.3, { seed: 6 }), // same length, different audio
      'Loops/Big A.wav': wavWith(big(1)),
      'Loops/Big A copy.wav': wavWith(big(1)),
      'Loops/Big B.wav': wavWith(big(1, 99)) // same length and same ends, differs in the middle
    })
    const s = await findDuplicates(db)
    expect(s.groups).toBe(2)
    expect(groups()).toEqual([
      ['Big A copy.wav', 'Big A.wav'],
      ['Kick (bwf).wav', 'Kick 01.wav', 'kick copy.wav']
    ])
    expect(getFile(db, id('Pack A/Kick 01.wav'))!.dupCount).toBe(2)
    expect(getFile(db, id('Other/Snare.wav'))!.dupCount).toBe(0)
    expect(s.fullyHashed).toBe(3) // only the three large same-length files needed a full read
  })

  it('only re-reads files that changed, and ignores missing copies', async () => {
    const kick = makeWav(0.3, { seed: 5 })
    const rootId = await scan({ 'a/Kick.wav': kick, 'b/Kick.wav': kick, 'c/Kick.wav': kick })
    await findDuplicates(db)
    const again = await findDuplicates(db)
    expect(again).toMatchObject({ located: 0, quickHashed: 0, fullyHashed: 0, groups: 1 })

    // Change one copy: it drops out of the set.
    const changed = path.join(lib(), 'c/Kick.wav')
    writeFileSync(changed, makeWav(0.3, { seed: 9 }))
    const later = new Date(Date.now() + 10_000)
    utimesSync(changed, later, later)
    rmSync(path.join(lib(), 'b/Kick.wav'))
    await scanRoot(db, rootId)
    const s = await findDuplicates(db)
    expect(s.located).toBe(1)
    expect(s.groups).toBe(0)
    expect(duplicateStats(db)).toEqual({ groups: 0, extra: 0, extraBytes: 0 })
  })

  it('reports how much space the extra copies take', async () => {
    const kick = makeWav(0.3, { seed: 5 })
    await scan({ 'a/K.wav': kick, 'b/K.wav': kick, 'c/K.wav': kick, 'd/S.wav': makeWav(0.2, { seed: 1 }), 'e/S.wav': makeWav(0.2, { seed: 1 }) })
    await findDuplicates(db)
    const s = duplicateStats(db)
    expect(s).toEqual({ groups: 2, extra: 3, extraBytes: kick.length * 2 + makeWav(0.2).length })
  })
})

describe('cleaning up duplicates', () => {
  let ids: Record<string, number>

  beforeEach(async () => {
    const kick = makeWav(0.3, { seed: 5 })
    const snare = makeWav(0.2, { seed: 7 })
    writeTree(path.join(dir, 'lib'), {
      'Pack/Kick.wav': kick,
      'Downloads/Kick (1).wav': kick,
      'Desktop/Kick final.wav': kick,
      'Pack/Snare.wav': snare,
      'Old/Snare.wav': snare,
      'Pack/Hat.wav': makeWav(0.1, { seed: 3 })
    })
    const root = addRoot(db, path.join(dir, 'lib'))
    await scanRoot(db, root.id)
    await findDuplicates(db)
    ids = Object.fromEntries(
      (db.prepare('SELECT id, rel_path FROM files').all() as Array<{ id: number; rel_path: string }>).map((r) => [r.rel_path.replace(/\\/g, '/'), r.id])
    )
  })

  it('picks extra copies, keeping the one you have worked on', () => {
    updateFiles(db, [ids['Desktop/Kick final.wav']], { rating: 4 })
    const extra = extraCopyIds(db, {})
    expect(extra).toHaveLength(3)
    expect(extra).not.toContain(ids['Desktop/Kick final.wav'])
    expect(extra).toContain(ids['Pack/Kick.wav'])
    expect(extra).not.toContain(ids['Pack/Hat.wav'])
    // Limited to the current view.
    expect(extraCopyIds(db, { search: 'snare' })).toHaveLength(1)
  })

  it('refuses to remove the last copy, or a file without duplicates', () => {
    const kicks = ['Pack/Kick.wav', 'Downloads/Kick (1).wav', 'Desktop/Kick final.wav'].map((k) => ids[k])
    expect(planTrash(db, kicks)).toEqual({ error: expect.stringContaining('every copy') })
    expect(planTrash(db, [ids['Pack/Hat.wav']])).toEqual({ error: expect.stringContaining("isn't a duplicate") })
    const ok = planTrash(db, kicks.slice(0, 2))
    expect('items' in ok && ok.items.map((i) => i.keeperId)).toEqual([kicks[2], kicks[2]])
  })

  it('carries ratings, tags, notes, collections and manual values to the kept copy', () => {
    const from = ids['Downloads/Kick (1).wav']
    const into = ids['Pack/Kick.wav']
    updateFiles(db, [from], { rating: 5, favorite: true, notes: 'the good one', bpm: 140 })
    updateFiles(db, [into], { rating: 2, notes: 'from the pack' })
    addTags(db, [from], ['hard'])
    addTags(db, [into], ['kick'])
    const c = createCollection(db, 'EP')
    addToCollection(db, c.id, [from])

    mergeFileData(db, from, into)
    forgetFiles(db, [from])

    expect(getFile(db, from)).toBeNull()
    expect(getFile(db, into)).toMatchObject({
      rating: 5,
      favorite: true,
      notes: 'from the pack\n\nthe good one',
      bpm: 140,
      bpmSource: 'manual',
      tags: ['hard', 'kick']
    })
    expect(queryFiles(db, { collectionId: c.id, sort: 'position', desc: false, offset: 0, limit: 5 }).map((f) => f.id)).toEqual([into])
    expect(getFile(db, into)!.dupCount).toBe(1)
  })
})
